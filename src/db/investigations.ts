import { randomUUID } from "node:crypto";
import type postgres from "postgres";

import type { CapabilityRegistry } from "../core/capabilities.ts";
import { dataClassificationSchema, type DataClassification, type InvestigationStatus, type RuntimeKind } from "../core/contracts.ts";
import {
  normalizeSubmission,
  sha256,
  validatePdfBytes,
} from "../core/input.ts";
import { getSql } from "./client.ts";

export type CreateInvestigationInput = {
  submission: string;
  runtimeKind: RuntimeKind;
  dataClassification: DataClassification;
  resume?: {
    bytes: Uint8Array;
    fileName: string;
  };
};

export type ClaimedRun = {
  id: string;
  investigationId: string;
  status: "RUNNING";
  runtimeKind: RuntimeKind;
  dataClassification: DataClassification;
  attemptCount: number;
  leaseExpiresAt: Date;
  deadlineAt: Date;
};

export type AgentEventInput = {
  investigationId: string;
  runId: string;
  phase: string;
  agent: string;
  sessionId?: string;
  eventType: string;
  tool?: string;
  source?: string;
  status: string;
  budgetDelta?: Record<string, number>;
  publicRationale?: string;
  payload?: Record<string, unknown>;
};

export type AgentEvent = AgentEventInput & {
  id: number;
  createdAt: Date;
};

function toJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

export async function createInvestigation(input: CreateInvestigationInput): Promise<{
  investigationId: string;
  runId: string;
}> {
  const dataClassification = dataClassificationSchema.parse(input.dataClassification);
  const submission = normalizeSubmission(input.submission);
  if (input.resume) validatePdfBytes(input.resume.bytes);

  const sql = getSql();
  return sql.begin(async (transaction) => {
    const investigationId = randomUUID();
    const runId = randomUUID();

    await transaction`
      INSERT INTO investigations (
        id, status, runtime_kind, data_classification, submission_kind,
        submission_raw, submission_normalized, submission_sha256, latest_run_id
      ) VALUES (
        ${investigationId}, 'QUEUED', ${input.runtimeKind}, ${dataClassification},
        ${submission.kind}, ${submission.raw}, ${submission.normalized},
        ${sha256(submission.raw)}, ${runId}
      )
    `;

    await transaction`
      INSERT INTO runs (
        id, investigation_id, status, capability_snapshot, budget_counters
      ) VALUES (
        ${runId}, ${investigationId}, 'QUEUED',
        NULL,
        ${transaction.json({ modelUsd: 0, providerUsd: 0 })}
      )
    `;

    if (input.resume) {
      const artifactId = randomUUID();
      const bytes = Buffer.from(input.resume.bytes);
      await transaction`
        INSERT INTO artifacts (
          id, investigation_id, run_id, kind, mime_type, file_name,
          http_metadata, sha256, byte_length, content_bytes, provenance,
          source_authority, independence_group, canonical_source_url
        ) VALUES (
          ${artifactId}, ${investigationId}, ${runId}, 'INPUT_PDF',
          'application/pdf', ${input.resume.fileName}, ${transaction.json({})},
          ${sha256(bytes)}, ${bytes.byteLength}, ${bytes},
          ${transaction.json({ source: "SUBMISSION", immutable: true })},
          'SELF_REPRESENTATION', 'candidate-submission',
          ${`urn:translucid:submission:${artifactId}`}
        )
      `;
      await transaction`
        UPDATE investigations SET resume_artifact_id = ${artifactId}, updated_at = now()
        WHERE id = ${investigationId}
      `;
    }

    return { investigationId, runId };
  });
}

export async function persistRunCapabilitySnapshot(
  runId: string,
  leaseOwner: string,
  registry: CapabilityRegistry,
): Promise<void> {
  const [row] = await getSql()<Array<{ id: string }>>`
    UPDATE runs SET capability_snapshot = ${getSql().json(toJson(registry))}, updated_at = now()
    WHERE id = ${runId} AND status = 'RUNNING' AND lease_owner = ${leaseOwner}
      AND capability_snapshot IS NULL
    RETURNING id
  `;
  if (!row) throw new Error("Runner could not establish the authoritative capability snapshot.");
}

export async function claimRuns(input: {
  leaseOwner: string;
  limit: number;
  leaseMs: number;
  timeoutMs: number;
}): Promise<ClaimedRun[]> {
  if (input.limit < 1) return [];
  const sql = getSql();

  return sql.begin(async (transaction) => {
    const claimed = await transaction<ClaimedRun[]>`
      WITH available AS (
        SELECT id
        FROM runs
        WHERE status = 'QUEUED'
           OR (status = 'RUNNING' AND lease_expires_at < now())
        ORDER BY queued_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT ${input.limit}
      )
      UPDATE runs AS run
      SET status = 'RUNNING',
          lease_owner = ${input.leaseOwner},
          lease_expires_at = now() + (${input.leaseMs} * interval '1 millisecond'),
          heartbeat_at = now(),
          deadline_at = COALESCE(
            run.deadline_at,
            now() + (${input.timeoutMs} * interval '1 millisecond')
          ),
          started_at = COALESCE(run.started_at, now()),
          attempt_count = run.attempt_count + 1,
          updated_at = now()
      FROM available
      WHERE run.id = available.id
      RETURNING
        run.id,
        run.investigation_id AS "investigationId",
        run.status,
        run.attempt_count AS "attemptCount",
        run.lease_expires_at AS "leaseExpiresAt",
        run.deadline_at AS "deadlineAt",
        (SELECT runtime_kind FROM investigations WHERE id = run.investigation_id) AS "runtimeKind",
        (SELECT data_classification FROM investigations WHERE id = run.investigation_id) AS "dataClassification"
    `;

    if (claimed.length) {
      const investigationIds = claimed.map((run) => run.investigationId);
      await transaction`
        UPDATE investigations
        SET status = 'RUNNING', updated_at = now()
        WHERE id IN ${transaction(investigationIds)}
          AND cancel_requested_at IS NULL
      `;
    }

    return [...claimed];
  });
}

export async function heartbeatRun(
  runId: string,
  leaseOwner: string,
  leaseMs: number,
): Promise<{ leaseExpiresAt: Date }> {
  const [row] = await getSql()<{ leaseExpiresAt: Date }[]>`
    UPDATE runs
    SET heartbeat_at = now(),
        lease_expires_at = now() + (${leaseMs} * interval '1 millisecond'),
        updated_at = now()
    WHERE id = ${runId} AND lease_owner = ${leaseOwner} AND status = 'RUNNING'
    RETURNING lease_expires_at AS "leaseExpiresAt"
  `;
  if (!row) throw new Error("Run lease is no longer owned by this runner.");
  return row;
}

export async function requestCancellation(investigationId: string): Promise<{
  status: InvestigationStatus;
  cancelRequestedAt: Date;
}> {
  const sql = getSql();
  return sql.begin(async (transaction) => {
    const [row] = await transaction<
      { status: InvestigationStatus; cancelRequestedAt: Date }[]
    >`
      UPDATE investigations
      SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
          status = CASE
            WHEN status IN ('COMPLETED','FAILED','TIMED_OUT') THEN status
            ELSE 'CANCELLED'
          END,
          updated_at = now()
      WHERE id = ${investigationId}
      RETURNING status, cancel_requested_at AS "cancelRequestedAt"
    `;
    if (!row) throw new Error("Investigation not found.");

    await transaction`
      UPDATE runs
      SET status = 'CANCELLED', finished_at = now(), updated_at = now()
      WHERE investigation_id = ${investigationId} AND status = 'QUEUED'
    `;
    return row;
  });
}

export async function insertAgentEvent(input: AgentEventInput): Promise<AgentEvent> {
  const [event] = await getSql()<(Omit<AgentEvent, "id"> & { id: string | number })[]>`
    INSERT INTO agent_events (
      investigation_id, run_id, phase, agent, session_id, event_type,
      tool, source, status, budget_delta, public_rationale, payload
    ) VALUES (
      ${input.investigationId}, ${input.runId}, ${input.phase}, ${input.agent},
      ${input.sessionId ?? null}, ${input.eventType}, ${input.tool ?? null},
      ${input.source ?? null}, ${input.status},
      ${getSql().json(input.budgetDelta ?? {})}, ${input.publicRationale ?? null},
      ${getSql().json(toJson(input.payload ?? {}))}
    )
    RETURNING
      id, investigation_id AS "investigationId", run_id AS "runId", phase,
      agent, session_id AS "sessionId", event_type AS "eventType", tool,
      source, status, budget_delta AS "budgetDelta",
      public_rationale AS "publicRationale", payload, created_at AS "createdAt"
  `;
  if (!event) throw new Error("Failed to persist agent event.");
  return { ...event, id: Number(event.id) };
}

export async function listAgentEvents(
  investigationId: string,
  afterId: number,
): Promise<AgentEvent[]> {
  const rows = await getSql()<(Omit<AgentEvent, "id"> & { id: string | number })[]>`
    SELECT
      id, investigation_id AS "investigationId", run_id AS "runId", phase,
      agent, session_id AS "sessionId", event_type AS "eventType", tool,
      source, status, budget_delta AS "budgetDelta",
      public_rationale AS "publicRationale", payload, created_at AS "createdAt"
    FROM agent_events
    WHERE investigation_id = ${investigationId} AND id > ${afterId}
    ORDER BY id ASC
    LIMIT 500
  `;
  return rows.map((row) => ({ ...row, id: Number(row.id) }));
}
