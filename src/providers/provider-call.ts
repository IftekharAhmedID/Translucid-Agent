import { randomUUID } from "node:crypto";
import type postgres from "postgres";

import type { Capability } from "../core/capabilities.ts";
import { getSql } from "../db/client.ts";
import { insertAgentEvent } from "../db/investigations.ts";
import { captureArtifact } from "../db/state.ts";
import type { ProviderCostSource, ToolName } from "./contracts.ts";
import { redactSecrets } from "./http.ts";
import { providerDeadlineMs, providerTimeoutMs } from "./provider-policy.ts";
import { providerRequestFingerprint } from "./request-fingerprint.ts";
import { consumeBudget } from "./security.ts";

type ExecuteContext = {
  investigationId: string;
  runId: string;
  agent: string;
  sessionId: string;
};

export type ProviderArtifactInput = {
  kind: string;
  sourceUrl: string;
  mimeType?: string;
  content: unknown;
  status?: number;
  provenance?: Record<string, unknown>;
};

export type ProviderNetworkResult = {
  data: unknown;
  sourceUrl: string;
  status?: number;
  costUsd: number;
  costSource: ProviderCostSource;
  artifacts?: ProviderArtifactInput[];
};

export type ConcreteProviderResult = ProviderNetworkResult & {
  provider: string;
  providerRoute: string;
  artifactIds: string[];
  evidenceEligibleArtifactIds: string[];
  reused: boolean;
};

type ProviderCallRow = {
  id: string;
  provider: string;
  providerRoute: string;
  resultStatus: string;
  costSource: ProviderCostSource | null;
  costUsd: number;
  artifactIds: string[];
};

function asJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

function errorDetails(error: unknown): { message: string; status: string; retryAfterMs: number | null } {
  const responseStatus = typeof (error as { status?: unknown })?.status === "number"
    ? Number((error as { status: number }).status)
    : undefined;
  const rawRetryAfter = (error as { retryAfter?: unknown })?.retryAfter;
  const seconds = typeof rawRetryAfter === "string" && /^\d+(?:\.\d+)?$/.test(rawRetryAfter.trim())
    ? Number(rawRetryAfter) * 1_000
    : undefined;
  return {
    message: error instanceof Error ? error.message : "Provider request failed.",
    status: error instanceof Error && error.message.startsWith("Budget exhausted")
      ? "BUDGET_EXHAUSTED"
      : responseStatus === 429 ? "RATE_LIMITED" : "ERROR",
    retryAfterMs: Number.isFinite(seconds) ? Math.round(seconds!) : null,
  };
}

async function runDeadlineAt(runId: string): Promise<number> {
  const [run] = await getSql()<Array<{ deadlineAt: Date | string | null }>>`
    SELECT deadline_at AS "deadlineAt" FROM runs WHERE id = ${runId}
  `;
  if (!run) throw new Error("Run not found while preparing provider request.");
  return run.deadlineAt ? new Date(run.deadlineAt).getTime() : Date.now() + 60 * 60_000;
}

async function readCachedResponse(row: ProviderCallRow): Promise<ConcreteProviderResult> {
  if (row.artifactIds.length === 0) throw new Error("Cached provider call has no immutable artifacts.");
  const artifacts = await getSql()<Array<{
    id: string;
    kind: string;
    sourceUrl: string | null;
    contentBytes: Uint8Array;
  }>>`
    SELECT id, kind, source_url AS "sourceUrl", content_bytes AS "contentBytes"
    FROM artifacts
    WHERE id IN ${getSql()(row.artifactIds)}
    ORDER BY array_position(${row.artifactIds}::uuid[], id)
  `;
  if (artifacts.length !== row.artifactIds.length) throw new Error("Cached provider artifacts are incomplete.");
  const first = artifacts[0]!;
  let data: unknown;
  try { data = JSON.parse(Buffer.from(first.contentBytes).toString("utf8")); }
  catch { data = { text: Buffer.from(first.contentBytes).toString("utf8") }; }
  return {
    provider: row.provider,
    providerRoute: row.providerRoute,
    data,
    sourceUrl: first.sourceUrl ?? "https://invalid.example/unknown-source",
    costUsd: 0,
    costSource: row.costSource ?? "UNKNOWN",
    artifactIds: artifacts.map(({ id }) => id),
    evidenceEligibleArtifactIds: artifacts.filter(({ kind }) => kind !== "SEARCH_DISCOVERY").map(({ id }) => id),
    reused: true,
  };
}

async function findCompleted(runId: string, fingerprint: string): Promise<ProviderCallRow | undefined> {
  const [row] = await getSql()<ProviderCallRow[]>`
    SELECT id, provider, provider_route AS "providerRoute", result_status AS "resultStatus",
      cost_source AS "costSource", cost_usd AS "costUsd", artifact_ids AS "artifactIds"
    FROM provider_calls
    WHERE run_id = ${runId} AND request_fingerprint = ${fingerprint} AND result_status = 'OK'
    ORDER BY created_at DESC LIMIT 1
  `;
  return row;
}

async function waitForOwner(runId: string, fingerprint: string, deadlineAt: number): Promise<ProviderCallRow | undefined> {
  while (Date.now() < deadlineAt) {
    const completed = await findCompleted(runId, fingerprint);
    if (completed) return completed;
    const [active] = await getSql()<Array<{ resultStatus: string }>>`
      SELECT result_status AS "resultStatus" FROM provider_calls
      WHERE run_id = ${runId} AND request_fingerprint = ${fingerprint}
        AND result_status = 'IN_FLIGHT' LIMIT 1
    `;
    if (!active) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

async function recordCacheReuse(input: {
  context: ExecuteContext;
  capability: Capability;
  semanticTool: ToolName;
  completed: ProviderCallRow;
  fingerprint: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  await getSql()`
    INSERT INTO provider_calls (
      id, investigation_id, run_id, capability, provider, semantic_tool,
      provider_route, request_fingerprint, request_metadata, latency_ms,
      result_status, cost_source, attempt_count, reused_from_call_id, cost_usd,
      artifact_ids
    ) VALUES (
      ${randomUUID()}, ${input.context.investigationId}, ${input.context.runId},
      ${input.capability}, ${input.completed.provider}, ${input.semanticTool},
      ${input.completed.providerRoute}, ${input.fingerprint},
      ${getSql().json(asJson(input.metadata))}, 0, 'CACHE_HIT',
      ${input.completed.costSource ?? "UNKNOWN"}, 1, ${input.completed.id}, 0,
      ${input.completed.artifactIds}::uuid[]
    )
  `;
}

export async function executeConcreteProviderCall(input: {
  context: ExecuteContext;
  questionId: string;
  claimIds: string[];
  capability: Capability;
  semanticTool: ToolName;
  provider: string;
  providerRoute: string;
  networkArguments: Record<string, unknown>;
  publicRationale: string;
  countCeiling: number;
  providerBudgetUsd: number;
  knownCost?: Pick<ProviderNetworkResult, "costUsd" | "costSource">;
  run: (signal: AbortSignal, onAttempt: (attempt: number) => void) => Promise<ProviderNetworkResult>;
}): Promise<ConcreteProviderResult> {
  const sql = getSql();
  const fingerprint = providerRequestFingerprint(input.providerRoute, input.networkArguments);
  const caseDeadlineAt = await runDeadlineAt(input.context.runId);
  const routeDeadlineAt = Date.now() + providerDeadlineMs(input.providerRoute, caseDeadlineAt);
  const staleAfterMs = providerTimeoutMs(input.providerRoute) + 5_000;
  const metadata = redactSecrets({
    questionId: input.questionId,
    claimIds: input.claimIds,
    semanticTool: input.semanticTool,
    providerRoute: input.providerRoute,
    arguments: input.networkArguments,
  }) as Record<string, unknown>;

  for (;;) {
    await sql`
      UPDATE provider_calls SET result_status = 'ABANDONED'
      WHERE run_id = ${input.context.runId} AND request_fingerprint = ${fingerprint}
        AND result_status = 'IN_FLIGHT'
        AND created_at < now() - (${staleAfterMs} * interval '1 millisecond')
    `;
    const completed = await findCompleted(input.context.runId, fingerprint);
    if (completed) {
      await recordCacheReuse({ context: input.context, capability: input.capability, semanticTool: input.semanticTool, completed, fingerprint, metadata });
      await insertAgentEvent({
        ...input.context,
        phase: "RESEARCH",
        eventType: "PROVIDER_CACHE_HIT",
        tool: input.semanticTool,
        source: input.providerRoute,
        status: "COMPLETED",
        publicRationale: "Reused an immutable result for the same provider request.",
        payload: { providerCallId: completed.id, requestFingerprint: fingerprint },
      });
      return readCachedResponse(completed);
    }

    const callId = randomUUID();
    const inserted = await sql<Array<{ id: string }>>`
      INSERT INTO provider_calls (
        id, investigation_id, run_id, capability, provider, semantic_tool,
        provider_route, request_fingerprint, request_metadata, latency_ms,
        result_status, cost_source, attempt_count, cost_usd, artifact_ids
      ) VALUES (
        ${callId}, ${input.context.investigationId}, ${input.context.runId}, ${input.capability},
        ${input.provider}, ${input.semanticTool}, ${input.providerRoute}, ${fingerprint},
        ${sql.json(asJson(metadata))}, 0, 'IN_FLIGHT', 'UNKNOWN', 1, 0, '{}'::uuid[]
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    if (inserted.length === 0) {
      const owned = await waitForOwner(input.context.runId, fingerprint, routeDeadlineAt);
      if (owned) {
        await recordCacheReuse({ context: input.context, capability: input.capability, semanticTool: input.semanticTool, completed: owned, fingerprint, metadata });
        await insertAgentEvent({
          ...input.context,
          phase: "RESEARCH",
          eventType: "PROVIDER_CACHE_HIT",
          tool: input.semanticTool,
          source: input.providerRoute,
          status: "COMPLETED",
          publicRationale: "Reused a provider result completed by another agent.",
          payload: { providerCallId: owned.id, requestFingerprint: fingerprint },
        });
        return readCachedResponse(owned);
      }
      if (Date.now() >= routeDeadlineAt) throw new Error(`Timed out waiting for ${input.providerRoute}.`);
      continue;
    }

    const started = performance.now();
    let attemptCount = 1;
    try {
      await consumeBudget({
        runId: input.context.runId,
        counter: input.semanticTool,
        increment: 1,
        ceiling: input.countCeiling,
      });
      const reservedCostUsd = input.knownCost?.costSource === "CONFIGURED" ? input.knownCost.costUsd : 0;
      if (reservedCostUsd > 0) {
        await consumeBudget({
          runId: input.context.runId,
          counter: "providerUsd",
          increment: reservedCostUsd,
          ceiling: input.providerBudgetUsd,
        });
      }
      const requestMs = providerDeadlineMs(input.providerRoute, caseDeadlineAt);
      const result = await input.run(AbortSignal.timeout(requestMs), (attempt) => { attemptCount = Math.max(attemptCount, attempt); });
      const unreservedCostUsd = Math.max(0, result.costUsd - reservedCostUsd);
      if (unreservedCostUsd > 0 && ["REPORTED", "CONFIGURED"].includes(result.costSource)) {
        await consumeBudget({
          runId: input.context.runId,
          counter: "providerUsd",
          increment: unreservedCostUsd,
          ceiling: input.providerBudgetUsd,
        });
      }
      const artifactInputs = result.artifacts ?? [{
        kind: "PROVIDER_RESPONSE",
        sourceUrl: result.sourceUrl,
        content: result.data,
        status: result.status,
      }];
      const captured = [] as Array<{ id: string; kind: string }>;
      for (const artifactInput of artifactInputs) {
        const artifact = await captureArtifact({
          ...input.context,
          kind: artifactInput.kind,
          provider: input.provider,
          sourceUrl: artifactInput.sourceUrl,
          mimeType: artifactInput.mimeType ?? "application/json",
          content: typeof artifactInput.content === "string" ? artifactInput.content : JSON.stringify(artifactInput.content),
          provenance: {
            tool: input.semanticTool,
            providerRoute: input.providerRoute,
            requestFingerprint: fingerprint,
            networkArguments: redactSecrets(input.networkArguments),
            isSearchSnippet: artifactInput.kind === "SEARCH_DISCOVERY",
            immutable: true,
            ...(artifactInput.provenance ?? {}),
          },
          httpMetadata: { status: artifactInput.status ?? result.status ?? 200 },
        });
        captured.push({ id: artifact.id, kind: artifactInput.kind });
      }
      const artifactIds = captured.map(({ id }) => id);
      await sql`
        UPDATE provider_calls SET latency_ms = ${Math.max(0, Math.round(performance.now() - started))},
          result_status = 'OK', cost_source = ${result.costSource}, attempt_count = ${attemptCount},
          cost_usd = ${Math.max(0, result.costUsd)}, artifact_ids = ${artifactIds}::uuid[]
        WHERE id = ${callId}
      `;
      return {
        ...result,
        provider: input.provider,
        providerRoute: input.providerRoute,
        artifactIds,
        evidenceEligibleArtifactIds: captured.filter(({ kind }) => kind !== "SEARCH_DISCOVERY").map(({ id }) => id),
        reused: false,
      };
    } catch (error) {
      const details = errorDetails(error);
      await sql`
        UPDATE provider_calls SET latency_ms = ${Math.max(0, Math.round(performance.now() - started))},
          result_status = ${details.status}, attempt_count = ${attemptCount},
          retry_after_ms = ${details.retryAfterMs}
        WHERE id = ${callId}
      `;
      throw error;
    }
  }
}
