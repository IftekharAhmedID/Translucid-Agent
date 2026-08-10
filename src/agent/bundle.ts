import { getSql } from "../db/client.ts";

type Row = Record<string, unknown>;

function rows(bundle: Record<string, unknown>, key: string): Row[] {
  const value = bundle[key];
  return Array.isArray(value) ? value.filter((row): row is Row => Boolean(row) && typeof row === "object") : [];
}

function evidenceTierScore(evidence: Row): number {
  const tier = String(evidence.sourceTier ?? "").toUpperCase();
  if (tier === "DIRECT_WORK") return 6;
  if (tier === "FIRST_PARTY_INSTITUTIONAL") return 5;
  if (tier === "INDEPENDENT_PROFESSIONAL") return 4;
  if (tier === "SELF_REPRESENTATION") return 3;
  if (tier === "CONTEXT") return 2;
  if (tier === "DISCOVERY_ONLY") return 0;
  if (tier.includes("OFFICIAL") || tier.includes("AUTHORITATIVE")) return 5;
  if (tier.includes("INDEPENDENT") || tier.includes("PRIMARY")) return 4;
  if (tier.includes("AUTHORED") || tier.includes("SELF")) return 3;
  return 2;
}

export function selectEvidenceForCritic(evidence: Row[]): Row[] {
  const selected = new Map<string, Row>();
  const claimIds = new Set(evidence.flatMap(({ claimIds }) => Array.isArray(claimIds) ? claimIds.filter((id): id is string => typeof id === "string") : []));
  const caps: Record<string, number> = { SUPPORTS: 4, CONTRADICTS: 2, CONTEXT: 1 };
  for (const claimId of claimIds) {
    for (const [relation, cap] of Object.entries(caps)) {
      const candidates = evidence
        .filter((row) => row.relation === relation && Array.isArray(row.claimIds) && row.claimIds.includes(claimId))
        .sort((left, right) => evidenceTierScore(right) - evidenceTierScore(left) || String(left.id).localeCompare(String(right.id)));
      const diverse: Row[] = [];
      const seenGroups = new Set<string>();
      for (const candidate of candidates) {
        const artifactId = String(candidate.artifactId ?? "");
        const group = String(candidate.independenceGroup ?? `LEGACY_ARTIFACT:${artifactId}`);
        if (!artifactId || seenGroups.has(group)) continue;
        seenGroups.add(group);
        diverse.push(candidate);
      }
      for (const candidate of diverse) {
        if (selected.has(String(candidate.id)) || [...selected.values()].filter((row) => row.relation === relation && Array.isArray(row.claimIds) && row.claimIds.includes(claimId)).length >= cap) continue;
        selected.set(String(candidate.id), candidate);
      }
    }
  }
  return [...selected.values()];
}

export function buildAdjudicationBundle(
  frozen: Record<string, unknown>,
  acceptedEvidenceIds: Set<string>,
  critic: {
    claimConcerns: unknown[];
    identityConcerns: string[];
    chronologyConcerns: string[];
    limitations: string[];
  },
) {
  const evidence = rows(frozen, "evidence").filter(({ id }) => typeof id === "string" && acceptedEvidenceIds.has(id));
  const artifactIds = new Set(evidence.map(({ artifactId }) => artifactId).filter((id): id is string => typeof id === "string"));
  return {
    investigationId: frozen.investigationId,
    runId: frozen.runId,
    claims: rows(frozen, "claims").map(({ id, category, normalizedClaim, materiality, validFrom, validTo, status }) => ({ id, category, normalizedClaim, materiality, validFrom, validTo, status })),
    entities: rows(frozen, "entities").map(({ id, type, canonicalName }) => ({ id, type, canonicalName })),
    identifiers: rows(frozen, "identifiers").filter(({ evidenceId }) => typeof evidenceId === "string" && acceptedEvidenceIds.has(evidenceId)),
    links: rows(frozen, "links").filter(({ evidenceIds }) => Array.isArray(evidenceIds) && evidenceIds.some((id) => typeof id === "string" && acceptedEvidenceIds.has(id))),
    artifacts: rows(frozen, "artifacts")
      .filter(({ id }) => typeof id === "string" && artifactIds.has(id))
      .map(({ id, kind, provider, sourceUrl, retrievedAt, sha256 }) => ({ id, kind, provider, sourceUrl, retrievedAt, sha256 })),
    observations: rows(frozen, "observations").filter(({ artifactId }) => typeof artifactId === "string" && artifactIds.has(artifactId)),
    evidence,
    researchQuestions: rows(frozen, "researchQuestions").map(({ id, claimIds, question, priority, status, selectedRoute, resolutionSummary }) => ({ id, claimIds, question, priority, status, selectedRoute, resolutionSummary })),
    extractionLimitations: rows(frozen, "extractionLimitations"),
    critic: {
      claimConcerns: critic.claimConcerns,
      identityConcerns: critic.identityConcerns,
      chronologyConcerns: critic.chronologyConcerns,
      limitations: critic.limitations,
    },
  };
}

export async function buildFrozenEvidenceBundle(investigationId: string, runId: string): Promise<Record<string, unknown>> {
  const sql = getSql();
  const [claims, entities, identifiers, links, artifacts, observations, evidence, questions, extractionLimitations] = await Promise.all([
    sql`SELECT id, category, normalized_claim AS "normalizedClaim", materiality, source_span AS "sourceSpan", valid_from AS "validFrom", valid_to AS "validTo", status FROM claims WHERE investigation_id = ${investigationId} AND run_id = ${runId} ORDER BY created_at`,
    sql`SELECT id, type, canonical_name AS "canonicalName", metadata FROM entities WHERE investigation_id = ${investigationId} AND run_id = ${runId} ORDER BY created_at`,
    sql`SELECT id, entity_id AS "entityId", type, value, normalized_value AS "normalizedValue", confidence, evidence_id AS "evidenceId" FROM entity_identifiers WHERE investigation_id = ${investigationId} AND run_id = ${runId} ORDER BY created_at`,
    sql`SELECT id, from_entity_id AS "fromEntityId", to_entity_id AS "toEntityId", relationship, confidence, evidence_ids AS "evidenceIds" FROM entity_links WHERE investigation_id = ${investigationId} AND run_id = ${runId} ORDER BY created_at`,
    sql`SELECT id, kind, provider, source_url AS "sourceUrl", mime_type AS "mimeType", retrieved_at AS "retrievedAt", sha256, byte_length AS "byteLength", COALESCE(source_authority, 'CONTEXT') AS "sourceAuthority", COALESCE(independence_group, 'LEGACY_ARTIFACT:' || id::text) AS "independenceGroup", canonical_source_url AS "canonicalSourceUrl" FROM artifacts WHERE investigation_id = ${investigationId} ORDER BY created_at`,
    sql`SELECT id, artifact_id AS "artifactId", entity_id AS "entityId", field, value_json AS value, observed_at AS "observedAt", source_event_at AS "sourceEventAt", valid_from AS "validFrom", valid_to AS "validTo" FROM observations WHERE investigation_id = ${investigationId} AND run_id = ${runId} ORDER BY valid_from NULLS LAST, observed_at`,
    sql`SELECT evidence.id, evidence.artifact_id AS "artifactId", evidence.exact_quote AS "exactQuote", evidence.source_location AS "sourceLocation", COALESCE(artifact.source_authority, evidence.source_tier, 'CONTEXT') AS "sourceTier", COALESCE(artifact.independence_group, 'LEGACY_ARTIFACT:' || artifact.id::text) AS "independenceGroup", evidence.relation, evidence.claim_ids AS "claimIds", evidence.entity_ids AS "entityIds" FROM evidence JOIN artifacts AS artifact ON artifact.id = evidence.artifact_id WHERE evidence.investigation_id = ${investigationId} AND evidence.run_id = ${runId} ORDER BY evidence.created_at`,
    sql`SELECT id, claim_ids AS "claimIds", question, priority, status, selected_route AS "selectedRoute", resolution_summary AS "resolutionSummary" FROM research_questions WHERE investigation_id = ${investigationId} AND run_id = ${runId} ORDER BY created_at`,
    sql`SELECT event_type AS "eventType", public_rationale AS "publicRationale", payload FROM agent_events WHERE investigation_id = ${investigationId} AND run_id = ${runId} AND event_type = 'CLAIM_EXTRACTION_TRUNCATED' ORDER BY id`,
  ]);
  const selectedEvidence = selectEvidenceForCritic([...evidence]);
  const evidenceIds = new Set(selectedEvidence.map(({ id }) => String(id)));
  const artifactIds = new Set(selectedEvidence.map(({ artifactId }) => String(artifactId)));
  return {
    investigationId,
    runId,
    claims: [...claims],
    entities: [...entities],
    identifiers: [...identifiers].filter(({ evidenceId }) => evidenceIds.has(String(evidenceId))),
    links: [...links].filter(({ evidenceIds: ids }) => Array.isArray(ids) && ids.some((id) => evidenceIds.has(String(id)))),
    artifacts: [...artifacts].filter(({ id }) => artifactIds.has(String(id))),
    observations: [...observations].filter(({ artifactId }) => artifactIds.has(String(artifactId))),
    evidence: selectedEvidence,
    researchQuestions: [...questions],
    extractionLimitations: [...extractionLimitations],
    evidenceSelection: { originalCount: evidence.length, selectedCount: selectedEvidence.length, supportsPerClaim: 4, contradictionsPerClaim: 2, contextPerClaim: 1 },
  };
}
