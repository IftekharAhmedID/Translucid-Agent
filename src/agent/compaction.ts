import { getSql } from "../db/client.ts";

const MAX_COMPACTION_BYTES = 31 * 1024;

type CompactionPayload = {
  rootEntityId: string | null;
  resolvedIdentifiers: unknown[];
  entityLinks: unknown[];
  rejectedIdentityAttempts: unknown[];
  researchQuestions: unknown[];
  attemptedProviderRoutes: unknown[];
  knownDeadEnds: unknown[];
  strongestEvidence: unknown[];
  deadlineAt: string | null;
  budgetCounters: Record<string, number>;
};

function truncateStrings(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, 500);
  if (Array.isArray(value)) return value.map(truncateStrings);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, truncateStrings(item)]));
  return value;
}

export function serializeCompactionPayload(payload: CompactionPayload): string {
  const normalized = truncateStrings(payload) as CompactionPayload;
  let text = JSON.stringify(normalized);
  if (Buffer.byteLength(text) <= MAX_COMPACTION_BYTES) return text;
  const minimal = { ...normalized, truncated: true } as Record<string, unknown>;
  const pruneOrder = ["attemptedProviderRoutes", "resolvedIdentifiers", "entityLinks", "rejectedIdentityAttempts", "strongestEvidence"];
  for (const key of pruneOrder) {
    while (Buffer.byteLength(JSON.stringify(minimal)) > MAX_COMPACTION_BYTES && Array.isArray(minimal[key]) && (minimal[key] as unknown[]).length > 1) {
      (minimal[key] as unknown[]).pop();
    }
  }
  text = JSON.stringify(minimal);
  if (Buffer.byteLength(text) > MAX_COMPACTION_BYTES) throw new Error("Required durable compaction state exceeds 32 KiB.");
  return text;
}

export async function buildCompactionContext(investigationId: string, runId: string): Promise<string> {
  const sql = getSql();
  const [runs, identifiers, links, rejected, questions, providerCalls, evidence] = await Promise.all([
    sql<Array<{ rootEntityId: string | null; deadlineAt: Date | null; budgetCounters: Record<string, number> }>>`SELECT root_entity_id AS "rootEntityId", deadline_at AS "deadlineAt", budget_counters AS "budgetCounters" FROM runs WHERE id = ${runId} AND investigation_id = ${investigationId}`,
    sql`SELECT id, entity_id AS "entityId", type, normalized_value AS "normalizedValue", confidence, evidence_id AS "evidenceId" FROM entity_identifiers WHERE run_id = ${runId} ORDER BY confidence DESC, created_at LIMIT 60`,
    sql`SELECT id, from_entity_id AS "fromEntityId", to_entity_id AS "toEntityId", relationship, evidence_ids AS "evidenceIds" FROM entity_links WHERE run_id = ${runId} ORDER BY created_at LIMIT 40`,
    sql`SELECT id, payload FROM agent_events WHERE run_id = ${runId} AND event_type = 'IDENTITY_LINK_REJECTED' ORDER BY id DESC LIMIT 20`,
    sql`SELECT id, claim_ids AS "claimIds", status, selected_route AS "selectedRoute", left(COALESCE(resolution_summary, ''), 500) AS "resolutionSummary" FROM research_questions WHERE run_id = ${runId} ORDER BY created_at LIMIT 12`,
    sql`SELECT provider_route AS "providerRoute", request_fingerprint AS "requestFingerprint", result_status AS "resultStatus" FROM provider_calls WHERE run_id = ${runId} AND provider_route IS NOT NULL ORDER BY created_at DESC LIMIT 120`,
    sql`SELECT evidence.id, evidence.relation, evidence.claim_ids AS "claimIds", COALESCE(artifact.source_authority, 'CONTEXT') AS authority FROM evidence JOIN artifacts AS artifact ON artifact.id = evidence.artifact_id WHERE evidence.run_id = ${runId} AND evidence.relation IN ('SUPPORTS','CONTRADICTS') ORDER BY CASE COALESCE(artifact.source_authority, 'CONTEXT') WHEN 'DIRECT_WORK' THEN 1 WHEN 'FIRST_PARTY_INSTITUTIONAL' THEN 2 WHEN 'INDEPENDENT_PROFESSIONAL' THEN 3 WHEN 'SELF_REPRESENTATION' THEN 4 ELSE 5 END, evidence.created_at LIMIT 40`,
  ]);
  const run = runs[0];
  if (!run) throw new Error("Run not found while building compaction context.");
  const questionRows = [...questions] as Array<Record<string, unknown>>;
  const payload: CompactionPayload = {
    rootEntityId: run.rootEntityId,
    resolvedIdentifiers: [...identifiers],
    entityLinks: [...links],
    rejectedIdentityAttempts: [...rejected],
    researchQuestions: questionRows,
    attemptedProviderRoutes: [...providerCalls],
    knownDeadEnds: questionRows.filter(({ status }) => status === "EXHAUSTED" || status === "SKIPPED").map(({ id, claimIds, selectedRoute, resolutionSummary }) => ({ id, claimIds, selectedRoute, resolutionSummary })),
    strongestEvidence: [...evidence],
    deadlineAt: run.deadlineAt?.toISOString() ?? null,
    budgetCounters: run.budgetCounters,
  };
  return ["Durable state survives compaction; continue from these IDs and do not reconstruct state from memory.", serializeCompactionPayload(payload)].join("\n");
}
