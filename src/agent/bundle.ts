import { getSql } from "../db/client.ts";

type Row = Record<string, unknown>;

function rows(bundle: Record<string, unknown>, key: string): Row[] {
  const value = bundle[key];
  return Array.isArray(value) ? value.filter((row): row is Row => Boolean(row) && typeof row === "object") : [];
}

function evidenceTierScore(evidence: Row): number {
  const tier = String(evidence.sourceTier ?? "").toLowerCase();
  if (tier.includes("official") || tier.includes("authoritative")) return 4;
  if (tier.includes("independent")) return 3;
  if (tier.includes("authored") || tier.includes("self")) return 2;
  if (tier.includes("primary")) return 3;
  return 1;
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
      const seenArtifacts = new Set<string>();
      for (const candidate of candidates) {
        const artifactId = String(candidate.artifactId ?? "");
        if (!artifactId || seenArtifacts.has(artifactId)) continue;
        seenArtifacts.add(artifactId);
        diverse.push(candidate);
      }
      for (const candidate of [...diverse, ...candidates]) {
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
  const [claims, entities, identifiers, links, artifacts, observations, evidence, questions] = await Promise.all([
    sql`SELECT id, category, normalized_claim AS "normalizedClaim", materiality, source_span AS "sourceSpan", valid_from AS "validFrom", valid_to AS "validTo", status FROM claims WHERE investigation_id = ${investigationId} AND run_id = ${runId} ORDER BY created_at`,
    sql`SELECT id, type, canonical_name AS "canonicalName", metadata FROM entities WHERE investigation_id = ${investigationId} AND run_id = ${runId} ORDER BY created_at`,
    sql`SELECT id, entity_id AS "entityId", type, value, normalized_value AS "normalizedValue", confidence, evidence_id AS "evidenceId" FROM entity_identifiers WHERE investigation_id = ${investigationId} AND run_id = ${runId} ORDER BY created_at`,
    sql`SELECT id, from_entity_id AS "fromEntityId", to_entity_id AS "toEntityId", relationship, confidence, evidence_ids AS "evidenceIds" FROM entity_links WHERE investigation_id = ${investigationId} AND run_id = ${runId} ORDER BY created_at`,
    sql`SELECT id, kind, provider, source_url AS "sourceUrl", mime_type AS "mimeType", retrieved_at AS "retrievedAt", sha256, byte_length AS "byteLength" FROM artifacts WHERE investigation_id = ${investigationId} ORDER BY created_at`,
    sql`SELECT id, artifact_id AS "artifactId", entity_id AS "entityId", field, value_json AS value, observed_at AS "observedAt", source_event_at AS "sourceEventAt", valid_from AS "validFrom", valid_to AS "validTo" FROM observations WHERE investigation_id = ${investigationId} AND run_id = ${runId} ORDER BY valid_from NULLS LAST, observed_at`,
    sql`SELECT id, artifact_id AS "artifactId", exact_quote AS "exactQuote", source_location AS "sourceLocation", source_tier AS "sourceTier", relation, claim_ids AS "claimIds", entity_ids AS "entityIds" FROM evidence WHERE investigation_id = ${investigationId} AND run_id = ${runId} ORDER BY created_at`,
    sql`SELECT id, claim_ids AS "claimIds", question, priority, status, selected_route AS "selectedRoute", resolution_summary AS "resolutionSummary" FROM research_questions WHERE investigation_id = ${investigationId} AND run_id = ${runId} ORDER BY created_at`,
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
    evidenceSelection: { originalCount: evidence.length, selectedCount: selectedEvidence.length, supportsPerClaim: 4, contradictionsPerClaim: 2, contextPerClaim: 1 },
  };
}
