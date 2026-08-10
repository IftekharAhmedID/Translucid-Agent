import { randomUUID } from "node:crypto";
import type postgres from "postgres";

import type { EntityType, EscalationReason, ResearchQuestionStatus, ResearchWaveKind } from "../core/contracts.ts";
import { assessEntityLink, type IdentityAnchor } from "../core/identity.ts";
import { sha256 } from "../core/input.ts";
import { deriveArtifactTrust } from "../core/source-trust.ts";
import { getSql } from "./client.ts";

const MAX_CAPTURE_BYTES = 5 * 1024 * 1024;

type CaseIds = { investigationId: string; runId: string };
type Priority = "HIGH" | "MEDIUM" | "LOW";

function toJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

async function assertRowsBelongToCase(
  table: "claims" | "entities" | "evidence",
  ids: string[],
  investigationId: string,
  runId: string,
): Promise<void> {
  if (ids.length === 0) return;
  const rows = await getSql()<{ id: string }[]>`
    SELECT id FROM ${getSql()(table)}
    WHERE investigation_id = ${investigationId} AND run_id = ${runId} AND id IN ${getSql()(ids)}
  `;
  if (rows.length !== new Set(ids).size) {
    throw new Error(`One or more ${table} IDs do not belong to this investigation.`);
  }
}

export async function createClaim(
  input: CaseIds & {
    category: string;
    normalizedClaim: string;
    materiality: Priority;
    sourceSpan?: Record<string, unknown>;
    validFrom?: Date;
    validTo?: Date;
    agent?: string;
    sessionId?: string;
  },
): Promise<{ id: string }> {
  const id = randomUUID();
  const created = await getSql().begin(async (transaction) => {
    await transaction`SELECT id FROM runs WHERE id = ${input.runId} AND investigation_id = ${input.investigationId} FOR UPDATE`;
    const [count] = await transaction<Array<{ count: number }>>`
      SELECT count(*)::integer AS count FROM claims WHERE run_id = ${input.runId}
    `;
    if ((count?.count ?? 0) >= 60) return false;
    await transaction`
      INSERT INTO claims (
        id, investigation_id, run_id, category, normalized_claim, materiality,
        source_span, valid_from, valid_to
      ) VALUES (
        ${id}, ${input.investigationId}, ${input.runId}, ${input.category},
        ${input.normalizedClaim}, ${input.materiality},
        ${input.sourceSpan ? transaction.json(toJson(input.sourceSpan)) : null},
        ${input.validFrom ?? null}, ${input.validTo ?? null}
      )
    `;
    return true;
  });
  if (!created) {
    await getSql()`
      INSERT INTO agent_events (
        investigation_id, run_id, phase, agent, session_id, event_type,
        status, budget_delta, public_rationale, payload
      ) VALUES (
        ${input.investigationId}, ${input.runId}, 'INTAKE', ${input.agent ?? "gateway"},
        ${input.sessionId ?? null}, 'CLAIM_EXTRACTION_TRUNCATED', 'TRUNCATED', '{}'::jsonb,
        'The defensive 60-claim persistence cap was reached; additional reportable intake facts remain an explicit limitation.',
        ${getSql().json(toJson({ maximumClaims: 60 }))}
      )
    `;
    throw new Error("CLAIM_EXTRACTION_TRUNCATED: the 60-claim defensive cap was reached.");
  }
  return { id };
}

export async function upsertEntity(
  input: CaseIds & {
    type: EntityType;
    canonicalName: string;
    metadata?: Record<string, unknown>;
    role?: "CANDIDATE_ROOT" | "EXTERNAL";
    agent?: string;
  },
): Promise<{ id: string; canonicalName: string; type: EntityType }> {
  const canonicalName = input.canonicalName.trim();
  if (!canonicalName) throw new Error("Entity canonical name is required.");
  if (input.role === "CANDIDATE_ROOT" && (input.agent !== "lead-investigator" || input.type !== "PERSON")) {
    throw new Error("Only the lead investigator may establish the candidate root PERSON.");
  }

  return getSql().begin(async (transaction) => {
    const [row] = await transaction<
      { id: string; canonicalName: string; type: EntityType }[]
    >`
      INSERT INTO entities (
        id, investigation_id, run_id, type, canonical_name, metadata
      ) VALUES (
        ${randomUUID()}, ${input.investigationId}, ${input.runId}, ${input.type},
        ${canonicalName}, ${transaction.json(toJson(input.metadata ?? {}))}
      )
      ON CONFLICT (investigation_id, type, lower(canonical_name))
      DO UPDATE SET
        metadata = entities.metadata || EXCLUDED.metadata,
        updated_at = now()
      RETURNING id, canonical_name AS "canonicalName", type
    `;
    if (!row) throw new Error("Failed to upsert entity.");
    if (input.role === "CANDIDATE_ROOT") {
      const [run] = await transaction<Array<{ id: string }>>`
        UPDATE runs SET root_entity_id = ${row.id}, updated_at = now()
        WHERE id = ${input.runId} AND investigation_id = ${input.investigationId}
          AND (root_entity_id IS NULL OR root_entity_id = ${row.id})
        RETURNING id
      `;
      if (!run) throw new Error("A different candidate root is already established for this run.");
    }
    return row;
  });
}

export async function captureArtifact(
  input: CaseIds & {
    kind: string;
    provider: string;
    sourceUrl?: string;
    mimeType: string;
    fileName?: string;
    content: Uint8Array | string;
    httpMetadata?: Record<string, unknown>;
    provenance?: Record<string, unknown>;
  },
): Promise<{ id: string; sha256: string; byteLength: number }> {
  if (input.sourceUrl) {
    const sourceUrl = new URL(input.sourceUrl);
    if (!['http:', 'https:'].includes(sourceUrl.protocol)) {
      throw new Error("Artifact source URL must use HTTP or HTTPS.");
    }
  }
  const content = typeof input.content === "string" ? Buffer.from(input.content) : Buffer.from(input.content);
  if (content.byteLength > MAX_CAPTURE_BYTES) {
    throw new Error("Captured artifact exceeds the 5 MiB limit.");
  }

  const id = randomUUID();
  const digest = sha256(content);
  const provenance = input.provenance ?? {};
  let parsedContent: unknown = content.toString("utf8");
  if (input.mimeType === "application/json") {
    try { parsedContent = JSON.parse(String(parsedContent)) as unknown; }
    catch { /* retain the captured text for conservative lineage derivation */ }
  }
  const trust = deriveArtifactTrust({ kind: input.kind, provider: input.provider, sourceUrl: input.sourceUrl, provenance, content: parsedContent });
  await getSql()`
    INSERT INTO artifacts (
      id, investigation_id, run_id, kind, provider, source_url, mime_type,
      file_name, http_metadata, sha256, byte_length, content_bytes, provenance,
      source_authority, independence_group, canonical_source_url
    ) VALUES (
      ${id}, ${input.investigationId}, ${input.runId}, ${input.kind},
      ${input.provider}, ${input.sourceUrl ?? null}, ${input.mimeType},
      ${input.fileName ?? null}, ${getSql().json(toJson(input.httpMetadata ?? {}))},
      ${digest}, ${content.byteLength}, ${content},
      ${getSql().json(toJson(provenance))}, ${trust.sourceAuthority},
      ${trust.independenceGroup}, ${trust.canonicalSourceUrl}
    )
  `;
  return { id, sha256: digest, byteLength: content.byteLength };
}

export async function captureEvidence(
  input: CaseIds & {
    artifactId: string;
    exactQuote: string;
    sourceLocation?: Record<string, unknown>;
    relation: "SUPPORTS" | "CONTRADICTS" | "CONTEXT";
    claimIds: string[];
    entityIds: string[];
  },
): Promise<{ id: string }> {
  const [artifact] = await getSql()<
    { contentBytes: Uint8Array; provenance: Record<string, unknown>; mimeType: string; sourceAuthority: string | null }[]
  >`
    SELECT content_bytes AS "contentBytes", provenance, mime_type AS "mimeType",
      source_authority AS "sourceAuthority"
    FROM artifacts
    WHERE id = ${input.artifactId} AND investigation_id = ${input.investigationId}
      AND run_id = ${input.runId}
  `;
  if (!artifact) throw new Error("Artifact does not belong to this investigation.");
  if (artifact.provenance.isSearchSnippet === true) {
    throw new Error("Search snippets are discovery material and cannot become evidence.");
  }
  const quote = input.exactQuote.trim();
  if (!quote) throw new Error("An exact evidence quote is required.");
  if (/^(text\/|application\/(json|xml))/.test(artifact.mimeType)) {
    const capturedText = Buffer.from(artifact.contentBytes).toString("utf8");
    if (!capturedText.includes(quote)) {
      throw new Error("Evidence quote is not present in the captured artifact.");
    }
  }

  await Promise.all([
    assertRowsBelongToCase("claims", input.claimIds, input.investigationId, input.runId),
    assertRowsBelongToCase("entities", input.entityIds, input.investigationId, input.runId),
  ]);

  const id = randomUUID();
  await getSql()`
    INSERT INTO evidence (
      id, investigation_id, run_id, artifact_id, exact_quote, source_location,
      source_tier, relation, claim_ids, entity_ids
    ) VALUES (
      ${id}, ${input.investigationId}, ${input.runId}, ${input.artifactId},
      ${quote}, ${getSql().json(toJson(input.sourceLocation ?? {}))},
      ${artifact.sourceAuthority ?? "CONTEXT"}, ${input.relation}, ${input.claimIds}::uuid[],
      ${input.entityIds}::uuid[]
    )
  `;
  return { id };
}

export async function linkEvidence(input: CaseIds & {
  evidenceId: string;
  claimIds: string[];
  entityIds: string[];
}): Promise<{ id: string; claimIds: string[]; entityIds: string[] }> {
  await Promise.all([
    assertRowsBelongToCase("evidence", [input.evidenceId], input.investigationId, input.runId),
    assertRowsBelongToCase("claims", input.claimIds, input.investigationId, input.runId),
    assertRowsBelongToCase("entities", input.entityIds, input.investigationId, input.runId),
  ]);
  const [row] = await getSql()<Array<{ id: string; claimIds: string[]; entityIds: string[] }>>`
    UPDATE evidence
    SET claim_ids = ARRAY(SELECT DISTINCT unnest(claim_ids || ${input.claimIds}::uuid[])),
        entity_ids = ARRAY(SELECT DISTINCT unnest(entity_ids || ${input.entityIds}::uuid[]))
    WHERE id = ${input.evidenceId} AND investigation_id = ${input.investigationId}
      AND run_id = ${input.runId}
    RETURNING id, claim_ids AS "claimIds", entity_ids AS "entityIds"
  `;
  if (!row) throw new Error("Evidence not found.");
  return row;
}

export async function addEntityIdentifier(
  input: CaseIds & {
    entityId: string;
    type: string;
    value: string;
    confidence: number;
    evidenceId: string;
  },
): Promise<{ id: string; normalizedValue: string }> {
  await Promise.all([
    assertRowsBelongToCase("entities", [input.entityId], input.investigationId, input.runId),
    assertRowsBelongToCase("evidence", [input.evidenceId], input.investigationId, input.runId),
  ]);
  if (input.confidence < 0 || input.confidence > 1) {
    throw new Error("Identifier confidence must be between 0 and 1.");
  }
  const normalizedValue = input.value.trim().toLocaleLowerCase("en-US");
  if (!normalizedValue) throw new Error("Identifier value is required.");

  const [row] = await getSql()<{ id: string; normalizedValue: string }[]>`
    INSERT INTO entity_identifiers (
      id, investigation_id, run_id, entity_id, type, value,
      normalized_value, confidence, evidence_id
    ) VALUES (
      ${randomUUID()}, ${input.investigationId}, ${input.runId}, ${input.entityId},
      ${input.type}, ${input.value.trim()}, ${normalizedValue},
      ${input.confidence}, ${input.evidenceId}
    )
    ON CONFLICT (entity_id, type, normalized_value)
    DO UPDATE SET
      confidence = GREATEST(entity_identifiers.confidence, EXCLUDED.confidence),
      evidence_id = EXCLUDED.evidence_id,
      updated_at = now()
    RETURNING id, normalized_value AS "normalizedValue"
  `;
  if (!row) throw new Error("Failed to add entity identifier.");
  return row;
}

export async function linkEntities(
  input: CaseIds & {
    fromEntityId: string;
    toEntityId: string;
    relationship: string;
    anchors: Array<Pick<IdentityAnchor, "type" | "evidenceId">>;
    agent?: string;
    sessionId?: string;
  },
): Promise<{ id: string; confidence: number }> {
  await Promise.all([
    assertRowsBelongToCase(
      "entities",
      [input.fromEntityId, input.toEntityId],
      input.investigationId,
      input.runId,
    ),
    assertRowsBelongToCase(
      "evidence",
      input.anchors.map((anchor) => anchor.evidenceId),
      input.investigationId,
      input.runId,
    ),
  ]);
  const evidenceRows = await getSql()<Array<{ evidenceId: string; sourceKey: string }>>`
    SELECT evidence.id AS "evidenceId",
      COALESCE(artifact.independence_group, 'LEGACY_ARTIFACT:' || artifact.id::text) AS "sourceKey"
    FROM evidence
    JOIN artifacts AS artifact ON artifact.id = evidence.artifact_id
    WHERE evidence.id IN ${getSql()(input.anchors.map(({ evidenceId }) => evidenceId))}
      AND evidence.investigation_id = ${input.investigationId}
      AND evidence.run_id = ${input.runId}
  `;
  const sourceKeys = new Map(evidenceRows.map(({ evidenceId, sourceKey }) => [evidenceId, sourceKey]));
  const backendAnchors = input.anchors.map((anchor) => ({ ...anchor, sourceKey: sourceKeys.get(anchor.evidenceId) ?? `MISSING:${anchor.evidenceId}` }));
  const assessment = assessEntityLink(backendAnchors);
  if (!assessment.allowed) {
    await getSql()`
      INSERT INTO agent_events (
        investigation_id, run_id, phase, agent, session_id, event_type,
        status, budget_delta, public_rationale, payload
      ) VALUES (
        ${input.investigationId}, ${input.runId}, 'IDENTITY', ${input.agent ?? "gateway"},
        ${input.sessionId ?? null}, 'IDENTITY_LINK_REJECTED', 'REJECTED', '{}'::jsonb,
        'The proposed identity link lacked two evidence-backed anchor types from independent source families.',
        ${getSql().json(toJson({ fromEntityId: input.fromEntityId, toEntityId: input.toEntityId, evidenceIds: input.anchors.map(({ evidenceId }) => evidenceId), reason: assessment.reason }))}
      )
    `;
    throw new Error("Two independent evidence-backed identity anchors are required.");
  }

  const id = randomUUID();
  await getSql()`
    INSERT INTO entity_links (
      id, investigation_id, run_id, from_entity_id, to_entity_id,
      relationship, confidence, evidence_ids
    ) VALUES (
      ${id}, ${input.investigationId}, ${input.runId}, ${input.fromEntityId},
      ${input.toEntityId}, ${input.relationship}, ${assessment.confidence},
      ${backendAnchors.map((anchor) => anchor.evidenceId)}::uuid[]
    )
  `;
  return { id, confidence: assessment.confidence };
}

export async function recordObservation(
  input: CaseIds & {
    artifactId: string;
    entityId: string;
    field: string;
    value: unknown;
    observedAt?: Date;
    sourceEventAt?: Date;
    validFrom?: Date;
    validTo?: Date;
  },
): Promise<{ id: string }> {
  await assertRowsBelongToCase("entities", [input.entityId], input.investigationId, input.runId);
  const [artifact] = await getSql()<{ id: string }[]>`
    SELECT id FROM artifacts
    WHERE id = ${input.artifactId} AND investigation_id = ${input.investigationId}
      AND run_id = ${input.runId}
  `;
  if (!artifact) throw new Error("Artifact does not belong to this investigation.");

  const id = randomUUID();
  await getSql()`
    INSERT INTO observations (
      id, investigation_id, run_id, artifact_id, entity_id, field,
      value_json, observed_at, source_event_at, valid_from, valid_to
    ) VALUES (
      ${id}, ${input.investigationId}, ${input.runId}, ${input.artifactId},
      ${input.entityId}, ${input.field}, ${getSql().json(toJson(input.value))},
      ${input.observedAt ?? new Date()}, ${input.sourceEventAt ?? null},
      ${input.validFrom ?? null}, ${input.validTo ?? null}
    )
  `;
  return { id };
}

export async function listTimeline(investigationId: string, runId: string, entityId?: string): Promise<
  {
    id: string;
    entityId: string;
    field: string;
    value: unknown;
    observedAt: Date;
    sourceEventAt: Date | null;
    validFrom: Date | null;
    validTo: Date | null;
    artifactId: string;
  }[]
> {
  const rows = await getSql()<
    {
      id: string;
      entityId: string;
      field: string;
      value: unknown;
      observedAt: Date;
      sourceEventAt: Date | null;
      validFrom: Date | null;
      validTo: Date | null;
      artifactId: string;
    }[]
  >`
    SELECT id, entity_id AS "entityId", field, value_json AS value,
      observed_at AS "observedAt", source_event_at AS "sourceEventAt",
      valid_from AS "validFrom", valid_to AS "validTo", artifact_id AS "artifactId"
    FROM observations
    WHERE investigation_id = ${investigationId} AND run_id = ${runId}
      AND (${entityId ?? null}::uuid IS NULL OR entity_id = ${entityId ?? null})
    ORDER BY valid_from NULLS LAST, observed_at, id
  `;
  return [...rows];
}

export async function getEntityGraph(investigationId: string, runId: string): Promise<{
  entities: unknown[];
  identifiers: unknown[];
  links: unknown[];
}> {
  const sql = getSql();
  const [entityRows, identifierRows, linkRows] = await Promise.all([
    sql`SELECT id, type, canonical_name AS "canonicalName", metadata, created_at AS "createdAt" FROM entities WHERE investigation_id = ${investigationId} AND run_id = ${runId} ORDER BY created_at, id`,
    sql`SELECT id, entity_id AS "entityId", type, value, normalized_value AS "normalizedValue", confidence, evidence_id AS "evidenceId" FROM entity_identifiers WHERE investigation_id = ${investigationId} AND run_id = ${runId} ORDER BY created_at, id`,
    sql`SELECT id, from_entity_id AS "fromEntityId", to_entity_id AS "toEntityId", relationship, confidence, evidence_ids AS "evidenceIds" FROM entity_links WHERE investigation_id = ${investigationId} AND run_id = ${runId} ORDER BY created_at, id`,
  ]);
  return { entities: [...entityRows], identifiers: [...identifierRows], links: [...linkRows] };
}

export async function openResearchQuestion(
  input: CaseIds & {
    claimIds: string[];
    question: string;
    priority: Priority;
    possibleRoutes: string[];
    createdByAgent: string;
    createdBySession?: string;
  },
): Promise<{ id: string; status: "OPEN" }> {
  await assertRowsBelongToCase("claims", input.claimIds, input.investigationId, input.runId);
  const id = randomUUID();
  const opened = await getSql().begin(async (transaction) => {
    await transaction`SELECT id FROM runs WHERE id = ${input.runId} AND investigation_id = ${input.investigationId} FOR UPDATE`;
    const [count] = await transaction<Array<{ count: number }>>`
      SELECT count(*)::integer AS count FROM research_questions WHERE run_id = ${input.runId}
    `;
    if ((count?.count ?? 0) >= 12) return false;
    await transaction`
      INSERT INTO research_questions (
        id, investigation_id, run_id, claim_ids, question, priority,
        status, possible_routes, created_by_agent, created_by_session
      ) VALUES (
        ${id}, ${input.investigationId}, ${input.runId}, ${input.claimIds}::uuid[],
        ${input.question}, ${input.priority}, 'OPEN',
        ${transaction.json(toJson(input.possibleRoutes))}, ${input.createdByAgent},
        ${input.createdBySession ?? null}
      )
    `;
    return true;
  });
  if (!opened) throw new Error("The durable Research Frontier is limited to 12 grouped questions.");
  return { id, status: "OPEN" };
}

const researchRoles = ["professional-investigator", "github-investigator", "web-records-investigator", "social-investigator"] as const;
type ResearchRole = (typeof researchRoles)[number];

export async function beginResearchWave(input: CaseIds & {
  kind: ResearchWaveKind;
  questionIds: string[];
  escalationReason?: EscalationReason;
  publicRationale: string;
  agent: string;
  sessionId?: string;
}): Promise<{ waveNumber: 1 | 2; kind: ResearchWaveKind; questionIds: string[] }> {
  if (input.agent !== "lead-investigator") throw new Error("Only the lead investigator may begin a research wave.");
  return getSql().begin(async (transaction) => {
    const [run] = await transaction<Array<{ waveCount: number; waveState: Record<string, unknown> }>>`
      SELECT research_wave_count AS "waveCount", research_wave_state AS "waveState"
      FROM runs WHERE id = ${input.runId} AND investigation_id = ${input.investigationId} FOR UPDATE
    `;
    if (!run) throw new Error("Run not found while beginning research wave.");
    if (run.waveCount >= 2) throw new Error("A third research wave is not permitted.");
    if (input.kind === "INITIAL" && run.waveCount !== 0) throw new Error("The initial research wave has already begun.");
    if (input.kind === "TARGETED" && (run.waveCount !== 1 || !input.escalationReason)) throw new Error("A targeted second wave requires one completed initial wave and an allowed escalation reason.");
    if (input.kind === "TARGETED") {
      const current = run.waveState.current;
      const roles = current && typeof current === "object" && Array.isArray((current as { roles?: unknown }).roles) ? (current as { roles: unknown[] }).roles.map(String) : [];
      const completedRoles = current && typeof current === "object" && Array.isArray((current as { completedRoles?: unknown }).completedRoles) ? (current as { completedRoles: unknown[] }).completedRoles.map(String) : [];
      if (roles.some((role) => !completedRoles.includes(role))) throw new Error("The initial research tasks must finish before a targeted second wave begins.");
    }
    const active = await transaction<Array<{ id: string }>>`
      SELECT id FROM research_questions WHERE investigation_id = ${input.investigationId}
        AND run_id = ${input.runId} AND id IN ${transaction(input.questionIds)} AND status IN ('OPEN','IN_PROGRESS')
    `;
    if (active.length !== new Set(input.questionIds).size) throw new Error("Every research-wave question must be active in this run.");
    const waveNumber = (run.waveCount + 1) as 1 | 2;
    const priorWaves = Array.isArray(run.waveState.waves) ? run.waveState.waves : [];
    const wave = { waveNumber, kind: input.kind, questionIds: [...new Set(input.questionIds)], escalationReason: input.escalationReason ?? null, roles: [], completedRoles: [], publicRationale: input.publicRationale, startedAt: new Date().toISOString() };
    await transaction`
      UPDATE runs SET research_wave_count = ${waveNumber},
        research_wave_state = ${transaction.json(toJson({ waves: [...priorWaves, wave], current: wave }))},
        updated_at = now() WHERE id = ${input.runId}
    `;
    return { waveNumber, kind: input.kind, questionIds: wave.questionIds };
  });
}

export async function authorizeResearchTask(input: CaseIds & {
  role: ResearchRole;
  agent: string;
  sessionId?: string;
}): Promise<{ waveNumber: number; role: ResearchRole }> {
  if (input.agent !== "lead-investigator" || !researchRoles.includes(input.role)) throw new Error("Research task delegation is not authorized for this agent or role.");
  return getSql().begin(async (transaction) => {
    const [run] = await transaction<Array<{ waveCount: number; waveState: Record<string, unknown> }>>`
      SELECT research_wave_count AS "waveCount", research_wave_state AS "waveState"
      FROM runs WHERE id = ${input.runId} AND investigation_id = ${input.investigationId} FOR UPDATE
    `;
    if (!run || run.waveCount < 1 || run.waveCount > 2) throw new Error("Begin a durable research wave before delegating tasks.");
    const current = run.waveState.current;
    if (!current || typeof current !== "object") throw new Error("The current research wave is missing.");
    const roles = Array.isArray((current as { roles?: unknown }).roles) ? (current as { roles: unknown[] }).roles.map(String) : [];
    if (roles.includes(input.role)) throw new Error(`The ${input.role} role has already been delegated in this wave.`);
    const updatedCurrent = { ...(current as Record<string, unknown>), roles: [...roles, input.role] };
    const waves = Array.isArray(run.waveState.waves) ? [...run.waveState.waves] : [];
    waves[run.waveCount - 1] = updatedCurrent;
    await transaction`
      UPDATE runs SET research_wave_state = ${transaction.json(toJson({ waves, current: updatedCurrent }))},
        updated_at = now() WHERE id = ${input.runId}
    `;
    return { waveNumber: run.waveCount, role: input.role };
  });
}

export async function completeResearchTask(input: CaseIds & {
  role: ResearchRole;
  agent: string;
  sessionId?: string;
}): Promise<{ waveNumber: number; role: ResearchRole; completed: true }> {
  if (input.agent !== "lead-investigator" || !researchRoles.includes(input.role)) throw new Error("Research task completion is not authorized for this agent or role.");
  return getSql().begin(async (transaction) => {
    const [run] = await transaction<Array<{ waveCount: number; waveState: Record<string, unknown> }>>`
      SELECT research_wave_count AS "waveCount", research_wave_state AS "waveState"
      FROM runs WHERE id = ${input.runId} AND investigation_id = ${input.investigationId} FOR UPDATE
    `;
    const current = run?.waveState.current;
    if (!run || !current || typeof current !== "object") throw new Error("The current research wave is missing.");
    const roles = Array.isArray((current as { roles?: unknown }).roles) ? (current as { roles: unknown[] }).roles.map(String) : [];
    if (!roles.includes(input.role)) throw new Error(`The ${input.role} role was not authorized in this wave.`);
    const completed = Array.isArray((current as { completedRoles?: unknown }).completedRoles) ? (current as { completedRoles: unknown[] }).completedRoles.map(String) : [];
    const updatedCurrent = { ...(current as Record<string, unknown>), completedRoles: [...new Set([...completed, input.role])] };
    const waves = Array.isArray(run.waveState.waves) ? [...run.waveState.waves] : [];
    waves[run.waveCount - 1] = updatedCurrent;
    await transaction`UPDATE runs SET research_wave_state = ${transaction.json(toJson({ waves, current: updatedCurrent }))}, updated_at = now() WHERE id = ${input.runId}`;
    return { waveNumber: run.waveCount, role: input.role, completed: true };
  });
}

export async function resolveResearchQuestion(
  input: CaseIds & {
    questionId: string;
    selectedRoute: string;
    status: Extract<ResearchQuestionStatus, "RESOLVED" | "EXHAUSTED" | "SKIPPED">;
    resolutionSummary: string;
  },
): Promise<{
  id: string;
  status: ResearchQuestionStatus;
  selectedRoute: string;
  resolvedAt: Date;
}> {
  const [row] = await getSql()<
    {
      id: string;
      status: ResearchQuestionStatus;
      selectedRoute: string;
      resolvedAt: Date;
    }[]
  >`
    UPDATE research_questions
    SET selected_route = ${input.selectedRoute}, status = ${input.status},
        resolution_summary = ${input.resolutionSummary}, resolved_at = now(),
        updated_at = now()
    WHERE id = ${input.questionId}
      AND investigation_id = ${input.investigationId}
      AND run_id = ${input.runId}
    RETURNING id, status, selected_route AS "selectedRoute", resolved_at AS "resolvedAt"
  `;
  if (!row) throw new Error("Research question not found.");
  return row;
}

export async function selectResearchRoute(input: CaseIds & {
  questionId: string;
  route: string;
}): Promise<{ id: string; status: "IN_PROGRESS"; selectedRoute: string }> {
  const [row] = await getSql()<Array<{ id: string; status: "IN_PROGRESS"; selectedRoute: string }>>`
    UPDATE research_questions
    SET selected_route = ${input.route}, status = 'IN_PROGRESS', updated_at = now()
    WHERE id = ${input.questionId}
      AND investigation_id = ${input.investigationId}
      AND run_id = ${input.runId}
      AND status IN ('OPEN', 'IN_PROGRESS')
      AND possible_routes ? ${input.route}
    RETURNING id, status, selected_route AS "selectedRoute"
  `;
  if (!row) throw new Error("Research route is unavailable or question is closed.");
  return row;
}

export async function updateResearchQuestion(input: CaseIds & {
  questionId: string;
  priority?: Priority;
  possibleRoutes?: string[];
  status?: Extract<ResearchQuestionStatus, "OPEN" | "IN_PROGRESS">;
}): Promise<{ id: string; priority: Priority; possibleRoutes: string[]; status: ResearchQuestionStatus }> {
  if (!input.priority && !input.possibleRoutes && !input.status) throw new Error("A research question update is required.");
  const possibleRoutes = input.possibleRoutes ? getSql().json(toJson(input.possibleRoutes)) : null;
  const [row] = await getSql()<Array<{ id: string; priority: Priority; possibleRoutes: string[]; status: ResearchQuestionStatus }>>`
    UPDATE research_questions
    SET priority = COALESCE(${input.priority ?? null}, priority),
        possible_routes = COALESCE(${possibleRoutes}::jsonb, possible_routes),
        status = COALESCE(${input.status ?? null}, status), updated_at = now()
    WHERE id = ${input.questionId} AND investigation_id = ${input.investigationId}
      AND run_id = ${input.runId} AND status IN ('OPEN', 'IN_PROGRESS')
    RETURNING id, priority, possible_routes AS "possibleRoutes", status
  `;
  if (!row) throw new Error("Open research question not found.");
  return row;
}

export async function listResearchQuestions(investigationId: string, runId: string): Promise<unknown[]> {
  const rows = await getSql()`
    SELECT id, run_id AS "runId", claim_ids AS "claimIds", question, priority,
      status, possible_routes AS "possibleRoutes", selected_route AS "selectedRoute",
      created_by_agent AS "createdByAgent", created_by_session AS "createdBySession",
      resolution_summary AS "resolutionSummary", resolved_at AS "resolvedAt",
      created_at AS "createdAt", updated_at AS "updatedAt"
    FROM research_questions
    WHERE investigation_id = ${investigationId} AND run_id = ${runId}
    ORDER BY CASE priority WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
      created_at, id
  `;
  return [...rows];
}

const RESEARCH_RECONCILIATION_LIMITATION =
  "Research ended before this question could be resolved. Existing evidence and the unresolved limitation were preserved.";

export async function reconcileResearchFrontier(
  investigationId: string,
  runId: string,
): Promise<{ reconciledCount: number; activeCount: 0 }> {
  return getSql().begin(async (transaction) => {
    const reconciled = await transaction<Array<{ id: string }>>`
      UPDATE research_questions
      SET status = 'EXHAUSTED', resolution_summary = ${RESEARCH_RECONCILIATION_LIMITATION},
        resolved_at = now(), updated_at = now()
      WHERE investigation_id = ${investigationId} AND run_id = ${runId}
        AND status IN ('OPEN', 'IN_PROGRESS')
      RETURNING id
    `;
    const [active] = await transaction<Array<{ count: number }>>`
      SELECT count(*)::integer AS count FROM research_questions
      WHERE investigation_id = ${investigationId} AND run_id = ${runId}
        AND status IN ('OPEN', 'IN_PROGRESS')
    `;
    if ((active?.count ?? 0) !== 0) throw new Error("Research frontier reconciliation left active questions.");
    await transaction`
      INSERT INTO agent_events (
        investigation_id, run_id, phase, agent, event_type, status,
        budget_delta, public_rationale, payload
      ) VALUES (
        ${investigationId}, ${runId}, 'RESEARCH', 'runner',
        'RESEARCH_FRONTIER_RECONCILED', 'COMPLETED', '{}'::jsonb,
        ${RESEARCH_RECONCILIATION_LIMITATION},
        ${transaction.json(toJson({ reconciledQuestionIds: reconciled.map(({ id }) => id) }))}
      )
    `;
    return { reconciledCount: reconciled.length, activeCount: 0 as const };
  });
}
