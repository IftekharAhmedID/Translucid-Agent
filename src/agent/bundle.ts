import { getSql } from "../db/client.ts";

export async function buildFrozenEvidenceBundle(investigationId: string, runId: string): Promise<Record<string, unknown>> {
  const sql = getSql();
  const [claims, entities, identifiers, links, artifacts, observations, evidence, questions] = await Promise.all([
    sql`SELECT id, category, normalized_claim AS "normalizedClaim", materiality, source_span AS "sourceSpan", valid_from AS "validFrom", valid_to AS "validTo", status FROM claims WHERE investigation_id = ${investigationId} AND run_id = ${runId} ORDER BY created_at`,
    sql`SELECT id, type, canonical_name AS "canonicalName", metadata FROM entities WHERE investigation_id = ${investigationId} AND run_id = ${runId} ORDER BY created_at`,
    sql`SELECT id, entity_id AS "entityId", type, value, normalized_value AS "normalizedValue", confidence, evidence_id AS "evidenceId" FROM entity_identifiers WHERE investigation_id = ${investigationId} AND run_id = ${runId} ORDER BY created_at`,
    sql`SELECT id, from_entity_id AS "fromEntityId", to_entity_id AS "toEntityId", relationship, confidence, evidence_ids AS "evidenceIds" FROM entity_links WHERE investigation_id = ${investigationId} AND run_id = ${runId} ORDER BY created_at`,
    sql`SELECT id, kind, provider, source_url AS "sourceUrl", mime_type AS "mimeType", retrieved_at AS "retrievedAt", http_metadata AS "httpMetadata", sha256, byte_length AS "byteLength", provenance FROM artifacts WHERE investigation_id = ${investigationId} ORDER BY created_at`,
    sql`SELECT id, artifact_id AS "artifactId", entity_id AS "entityId", field, value_json AS value, observed_at AS "observedAt", source_event_at AS "sourceEventAt", valid_from AS "validFrom", valid_to AS "validTo" FROM observations WHERE investigation_id = ${investigationId} AND run_id = ${runId} ORDER BY valid_from NULLS LAST, observed_at`,
    sql`SELECT id, artifact_id AS "artifactId", exact_quote AS "exactQuote", source_location AS "sourceLocation", source_tier AS "sourceTier", relation, claim_ids AS "claimIds", entity_ids AS "entityIds" FROM evidence WHERE investigation_id = ${investigationId} AND run_id = ${runId} ORDER BY created_at`,
    sql`SELECT id, claim_ids AS "claimIds", question, priority, status, possible_routes AS "possibleRoutes", selected_route AS "selectedRoute", resolution_summary AS "resolutionSummary" FROM research_questions WHERE investigation_id = ${investigationId} AND run_id = ${runId} ORDER BY created_at`,
  ]);
  return { investigationId, runId, claims: [...claims], entities: [...entities], identifiers: [...identifiers], links: [...links], artifacts: [...artifacts], observations: [...observations], evidence: [...evidence], researchQuestions: [...questions] };
}
