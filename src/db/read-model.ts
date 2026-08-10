import { getSql } from "./client.ts";
import { providerCostCompleteness } from "../providers/cost-completeness.ts";

export async function listInvestigations(cursor?: string, limit = 30): Promise<{ items: unknown[]; nextCursor: string | null }> {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const rows = await getSql()<Array<Record<string, unknown> & { id: string; createdAt: Date }>>`
    SELECT investigation.id, investigation.status, investigation.runtime_kind AS "runtimeKind",
      investigation.submission_kind AS "submissionKind", investigation.created_at AS "createdAt",
      investigation.updated_at AS "updatedAt", investigation.final_summary AS "finalSummary",
      run.id AS "runId", run.started_at AS "startedAt", run.finished_at AS "finishedAt",
      run.cleanup_status AS "cleanupStatus", run.budget_counters AS "budgetCounters",
      (SELECT count(*)::int FROM claims WHERE investigation_id = investigation.id) AS "claimCount",
      (SELECT count(*)::int FROM evidence WHERE investigation_id = investigation.id) AS "evidenceCount",
      left(investigation.submission_normalized, 180) AS preview
    FROM investigations AS investigation
    LEFT JOIN runs AS run ON run.id = investigation.latest_run_id
    WHERE (${cursor ?? null}::uuid IS NULL OR investigation.id < ${cursor ?? null})
    ORDER BY investigation.created_at DESC, investigation.id DESC
    LIMIT ${safeLimit + 1}
  `;
  const hasMore = rows.length > safeLimit;
  const items = rows.slice(0, safeLimit);
  return { items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null };
}

export async function getInvestigationDetail(investigationId: string): Promise<Record<string, unknown> | undefined> {
  const sql = getSql();
  const [investigation] = await sql<Array<Record<string, unknown>>>`
    SELECT investigation.id, investigation.status, investigation.runtime_kind AS "runtimeKind",
      investigation.data_classification AS "dataClassification", investigation.submission_kind AS "submissionKind",
      investigation.submission_raw AS "submissionRaw", investigation.submission_normalized AS "submissionNormalized",
      investigation.submission_sha256 AS "submissionSha256", investigation.resume_artifact_id AS "resumeArtifactId",
      investigation.final_summary AS "finalSummary", investigation.cancel_requested_at AS "cancelRequestedAt",
      investigation.created_at AS "createdAt", investigation.updated_at AS "updatedAt",
      run.id AS "runId", run.status AS "runStatus", run.started_at AS "startedAt", run.finished_at AS "finishedAt",
      run.deadline_at AS "deadlineAt", run.cleanup_status AS "cleanupStatus", run.capability_snapshot AS "capabilitySnapshot",
      run.budget_counters AS "budgetCounters", run.runtime_manifest_hash AS "runtimeManifestHash",
      run.root_entity_id AS "rootEntityId", run.research_wave_count AS "researchWaveCount",
      run.research_wave_state AS "researchWaveState",
      run.error_code AS "errorCode", run.error_message AS "errorMessage",
      run.runtime_handle - 'gatewayScope' AS "runtimeHandle"
    FROM investigations AS investigation
    LEFT JOIN runs AS run ON run.id = investigation.latest_run_id
    WHERE investigation.id = ${investigationId}
  `;
  if (!investigation) return undefined;
  const [claims, entities, identifiers, links, artifacts, observations, evidenceRows, questions, findings, events, providerCalls] = await Promise.all([
    sql`SELECT id, category, normalized_claim AS "normalizedClaim", materiality, source_span AS "sourceSpan", valid_from AS "validFrom", valid_to AS "validTo", status, created_at AS "createdAt" FROM claims WHERE investigation_id = ${investigationId} ORDER BY created_at`,
    sql`SELECT id, type, canonical_name AS "canonicalName", metadata, created_at AS "createdAt" FROM entities WHERE investigation_id = ${investigationId} ORDER BY created_at`,
    sql`SELECT id, entity_id AS "entityId", type, value, normalized_value AS "normalizedValue", confidence, evidence_id AS "evidenceId" FROM entity_identifiers WHERE investigation_id = ${investigationId} ORDER BY created_at`,
    sql`SELECT id, from_entity_id AS "fromEntityId", to_entity_id AS "toEntityId", relationship, confidence, evidence_ids AS "evidenceIds" FROM entity_links WHERE investigation_id = ${investigationId} ORDER BY created_at`,
    sql`SELECT id, kind, provider, source_url AS "sourceUrl", mime_type AS "mimeType", file_name AS "fileName", retrieved_at AS "retrievedAt", sha256, byte_length AS "byteLength", provenance, COALESCE(source_authority, 'CONTEXT') AS "sourceAuthority", COALESCE(independence_group, 'LEGACY_ARTIFACT:' || id::text) AS "independenceGroup", canonical_source_url AS "canonicalSourceUrl" FROM artifacts WHERE investigation_id = ${investigationId} ORDER BY created_at`,
    sql`SELECT id, artifact_id AS "artifactId", entity_id AS "entityId", field, value_json AS value, observed_at AS "observedAt", source_event_at AS "sourceEventAt", valid_from AS "validFrom", valid_to AS "validTo" FROM observations WHERE investigation_id = ${investigationId} ORDER BY valid_from NULLS LAST, observed_at`,
    sql`SELECT id, artifact_id AS "artifactId", exact_quote AS "exactQuote", source_location AS "sourceLocation", source_tier AS "sourceTier", relation, claim_ids AS "claimIds", entity_ids AS "entityIds", created_at AS "createdAt" FROM evidence WHERE investigation_id = ${investigationId} ORDER BY created_at`,
    sql`SELECT id, claim_ids AS "claimIds", question, priority, status, possible_routes AS "possibleRoutes", selected_route AS "selectedRoute", created_by_agent AS "createdByAgent", resolution_summary AS "resolutionSummary", resolved_at AS "resolvedAt", created_at AS "createdAt" FROM research_questions WHERE investigation_id = ${investigationId} ORDER BY CASE priority WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, created_at`,
    sql`SELECT id, claim_id AS "claimId", verdict, strength, explanation, supporting_evidence_ids AS "supportingEvidenceIds", contradicting_evidence_ids AS "contradictingEvidenceIds", limitations, created_at AS "createdAt" FROM findings WHERE investigation_id = ${investigationId} ORDER BY created_at`,
    sql`SELECT id, phase, agent, session_id AS "sessionId", event_type AS "eventType", tool, source, status, budget_delta AS "budgetDelta", public_rationale AS "publicRationale", payload, created_at AS "createdAt" FROM agent_events WHERE investigation_id = ${investigationId} ORDER BY id DESC LIMIT 300`,
    sql`SELECT id, capability, provider, semantic_tool AS "semanticTool", provider_route AS "providerRoute",
      request_metadata AS "requestMetadata", request_fingerprint AS "requestFingerprint",
      latency_ms AS "latencyMs", result_status AS "resultStatus", cost_source AS "costSource",
      attempt_count AS "attemptCount", reused_from_call_id AS "reusedFromCallId",
      cost_usd AS "costUsd", retry_after_ms AS "retryAfterMs", artifact_ids AS "artifactIds",
      created_at AS "createdAt" FROM provider_calls WHERE investigation_id = ${investigationId} ORDER BY created_at`,
  ]);
  return { ...investigation, claims: [...claims], entities: [...entities], identifiers: [...identifiers], links: [...links], artifacts: [...artifacts], observations: [...observations], evidence: [...evidenceRows], researchQuestions: [...questions], findings: [...findings], events: [...events].reverse(), providerCalls: [...providerCalls], providerCostCompleteness: providerCostCompleteness(providerCalls as Array<{ costSource?: "REPORTED" | "CONFIGURED" | "FREE_PUBLIC" | "UNKNOWN" | null }>) };
}

export async function getArtifact(investigationId: string, artifactId: string): Promise<{
  bytes: Uint8Array; mimeType: string; fileName: string | null; sha256: string;
} | undefined> {
  const [row] = await getSql()<Array<{ bytes: Uint8Array; mimeType: string; fileName: string | null; sha256: string }>>`
    SELECT content_bytes AS bytes, mime_type AS "mimeType", file_name AS "fileName", sha256
    FROM artifacts WHERE id = ${artifactId} AND investigation_id = ${investigationId}
  `;
  return row;
}
