import { z } from "zod";

import {
  findingOutputSchema,
  investigationSummarySchema,
  type FindingOutput,
} from "../core/contracts.ts";

type Row = Record<string, unknown>;

export const criticOutputSchema = z.object({
  rejectedEvidence: z.array(z.object({ evidenceId: z.uuid(), reason: z.string().min(1).max(500) })).max(100),
  claimConcerns: z.array(z.object({ claimId: z.uuid(), concerns: z.array(z.string().min(1).max(500)).max(5) })).max(60),
  identityConcerns: z.array(z.string().min(1).max(500)).max(20),
  chronologyConcerns: z.array(z.string().min(1).max(500)).max(20),
  limitations: z.array(z.string().min(1).max(500)).max(20),
}).strict();

export const criticJsonExample = {
  rejectedEvidence: [],
  claimConcerns: [],
  identityConcerns: [],
  chronologyConcerns: [],
  limitations: [],
};

export const findingBatchOutputSchema = z.object({
  findings: z.array(findingOutputSchema).max(5),
}).strict();

export const summaryOutputSchema = z.object({
  summary: investigationSummarySchema,
}).strict();

export type CriticOutput = z.infer<typeof criticOutputSchema>;

export function partitionClaims<T>(claims: T[], batchSize = 5): T[][] {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("Batch size must be a positive integer.");
  const batches: T[][] = [];
  for (let index = 0; index < claims.length; index += batchSize) batches.push(claims.slice(index, index + batchSize));
  return batches;
}

export function mergeFindingBatches(batches: FindingOutput[][], expectedClaimIds: string[]): FindingOutput[] {
  const byClaim = new Map<string, FindingOutput>();
  for (const finding of batches.flat()) {
    if (byClaim.has(finding.claimId)) throw new Error(`Duplicate finding for claim ${finding.claimId}.`);
    byClaim.set(finding.claimId, finding);
  }
  const extras = [...byClaim.keys()].filter((id) => !expectedClaimIds.includes(id));
  if (extras.length) throw new Error(`Unexpected findings for claims: ${extras.join(", ")}.`);
  const missing = expectedClaimIds.filter((id) => !byClaim.has(id));
  if (missing.length) throw new Error(`Missing findings for claims: ${missing.join(", ")}.`);
  return expectedClaimIds.map((id) => byClaim.get(id)!);
}

export function buildCriticBatchBundle(bundle: Record<string, unknown>, claimIds: string[]) {
  const selectedClaims = new Set(claimIds);
  const evidence = rows(bundle, "evidence").filter(({ claimIds: ids }) => Array.isArray(ids) && ids.some((id) => typeof id === "string" && selectedClaims.has(id)));
  const artifactIds = new Set(evidence.map(({ artifactId }) => String(artifactId)));
  const claimPackets = rows(bundle, "claims")
    .filter(({ id }) => typeof id === "string" && selectedClaims.has(id))
    .map((claim) => {
      const claimId = String(claim.id);
      const claimEvidence = evidence.filter(({ claimIds: ids }) => Array.isArray(ids) && ids.includes(claimId));
      const facets = Array.isArray(claim.facets) ? claim.facets : [];
      return {
        claimId,
        facets: facets.map((facet) => {
          const facetKey = String((facet as Row).key ?? "");
          return {
            key: facetKey,
            label: String((facet as Row).label ?? facetKey),
            eligibleEvidenceIds: claimEvidence
              .filter(({ relation, facetKeys }) => (relation === "SUPPORTS" || relation === "CONTRADICTS") && Array.isArray(facetKeys) && facetKeys.includes(facetKey))
              .map(({ id }) => String(id)),
          };
        }),
        evidence: claimEvidence,
      };
    });
  return {
    claims: rows(bundle, "claims").filter(({ id }) => typeof id === "string" && selectedClaims.has(id)),
    claimPackets,
    entities: rows(bundle, "entities"),
    identifiers: rows(bundle, "identifiers"),
    links: rows(bundle, "links"),
    artifacts: rows(bundle, "artifacts").filter(({ id }) => artifactIds.has(String(id))),
    observations: rows(bundle, "observations").filter(({ artifactId }) => artifactIds.has(String(artifactId))),
    evidence,
    researchQuestions: rows(bundle, "researchQuestions").filter(({ claimIds: ids }) => Array.isArray(ids) && ids.some((id) => typeof id === "string" && selectedClaims.has(id))),
    extractionLimitations: rows(bundle, "extractionLimitations"),
  };
}

export function validateCriticBatch(output: CriticOutput, expectedClaimIds: Set<string>, eligibleEvidenceIds: Set<string>): CriticOutput {
  for (const rejection of output.rejectedEvidence) {
    if (!eligibleEvidenceIds.has(rejection.evidenceId)) throw new Error(`Critic batch referenced ineligible evidence ID ${rejection.evidenceId}.`);
  }
  for (const concern of output.claimConcerns) {
    if (!expectedClaimIds.has(concern.claimId)) throw new Error(`Critic batch referenced an unassigned claim ID ${concern.claimId}.`);
  }
  return output;
}

function uniqueStrings(values: string[], maximum: number): string[] {
  return [...new Set(values)].slice(0, maximum);
}

export function mergeCriticBatches(batches: CriticOutput[]): CriticOutput {
  const rejectedEvidence = new Map<string, { evidenceId: string; reason: string }>();
  const claimConcerns = new Map<string, { claimId: string; concerns: string[] }>();
  for (const batch of batches) {
    for (const rejection of batch.rejectedEvidence) {
      if (!rejectedEvidence.has(rejection.evidenceId)) rejectedEvidence.set(rejection.evidenceId, rejection);
    }
    for (const concern of batch.claimConcerns) {
      const existing = claimConcerns.get(concern.claimId);
      claimConcerns.set(concern.claimId, {
        claimId: concern.claimId,
        concerns: uniqueStrings([...(existing?.concerns ?? []), ...concern.concerns], 5),
      });
    }
  }
  return criticOutputSchema.parse({
    rejectedEvidence: [...rejectedEvidence.values()],
    claimConcerns: [...claimConcerns.values()],
    identityConcerns: uniqueStrings(batches.flatMap(({ identityConcerns }) => identityConcerns), 20),
    chronologyConcerns: uniqueStrings(batches.flatMap(({ chronologyConcerns }) => chronologyConcerns), 20),
    limitations: uniqueStrings(batches.flatMap(({ limitations }) => limitations), 20),
  });
}

function rows(bundle: Record<string, unknown>, key: string): Row[] {
  const value = bundle[key];
  return Array.isArray(value) ? value.filter((row): row is Row => Boolean(row) && typeof row === "object") : [];
}

export function buildFindingBatchBundle(bundle: Record<string, unknown>, claimIds: string[]) {
  const selectedClaims = new Set(claimIds);
  const evidence = rows(bundle, "evidence").filter(({ claimIds: ids }) => Array.isArray(ids) && ids.some((id) => typeof id === "string" && selectedClaims.has(id)));
  const artifactIds = new Set(evidence.map(({ artifactId }) => String(artifactId)));
  const critic = bundle.critic && typeof bundle.critic === "object" ? bundle.critic as Row : {};
  const concerns = Array.isArray(critic.claimConcerns) ? critic.claimConcerns : [];
  const claims = rows(bundle, "claims").filter(({ id }) => typeof id === "string" && selectedClaims.has(id));
  return {
    claimPackets: claims.map((claim) => {
      const claimId = String(claim.id);
      const eligibleEvidence = evidence.filter(({ claimIds: ids }) => Array.isArray(ids) && ids.includes(claimId));
      const facets = Array.isArray(claim.facets) ? claim.facets : [];
      return {
        claim,
        facets: facets.map((facet) => {
          const facetKey = String((facet as Row).key ?? "");
          return {
            key: facetKey,
            label: String((facet as Row).label ?? facetKey),
            eligibleEvidenceIds: eligibleEvidence
              .filter(({ relation, facetKeys }) => (relation === "SUPPORTS" || relation === "CONTRADICTS") && Array.isArray(facetKeys) && facetKeys.includes(facetKey))
              .map(({ id }) => String(id)),
          };
        }),
        contextEvidence: eligibleEvidence.filter(({ relation }) => relation === "CONTEXT"),
        concerns: concerns.filter((concern) => Boolean(concern) && typeof concern === "object" && String((concern as Row).claimId) === claimId),
      };
    }),
    artifacts: rows(bundle, "artifacts").filter(({ id }) => artifactIds.has(String(id))),
    observations: rows(bundle, "observations").filter(({ artifactId }) => artifactIds.has(String(artifactId))),
    researchQuestions: rows(bundle, "researchQuestions").filter(({ claimIds: ids }) => Array.isArray(ids) && ids.some((id) => typeof id === "string" && selectedClaims.has(id))),
    limitations: Array.isArray(critic.limitations) ? critic.limitations : [],
  };
}

export function buildSummaryBundle(bundle: Record<string, unknown>, findings: FindingOutput[], auditStats?: unknown) {
  const critic = bundle.critic && typeof bundle.critic === "object" ? bundle.critic as Row : {};
  const evidence = rows(bundle, "evidence").filter(({ relation }) => relation !== "CONTEXT");
  const claims = rows(bundle, "claims");
  const identityClaimCandidates = claims
    .filter(({ category }) => category === "identity" || category === "employment")
    .map(({ id }) => id)
    .filter((id): id is string => typeof id === "string");
  const timelineClaimCandidates = claims
    .filter(({ category }) => category === "employment" || category === "affiliation")
    .map(({ id }) => id)
    .filter((id): id is string => typeof id === "string");
  return {
    validatedFindings: findings,
    claims: claims.map(({ id, category, normalizedClaim, facets, materiality }) => ({ id, category, normalizedClaim, facets, materiality })),
    identityClaimCandidates,
    timelineClaimCandidates,
    evidenceByClaim: claims.map((claim) => ({
      claimId: claim.id,
      facets: claim.facets,
      evidence: evidence.filter(({ claimIds }) => Array.isArray(claimIds) && claimIds.includes(claim.id)),
    })),
    acceptedEvidence: evidence,
    entityResolution: {
      entities: rows(bundle, "entities"),
      identifiers: rows(bundle, "identifiers"),
      links: rows(bundle, "links"),
    },
    observations: rows(bundle, "observations"),
    auditStats,
    capabilityLimitations: [
      ...(Array.isArray(critic.limitations) ? critic.limitations : []),
      ...rows(bundle, "extractionLimitations").flatMap(({ publicRationale }) => typeof publicRationale === "string" ? [publicRationale] : []),
    ],
  };
}

export async function mapWithConcurrency<T, R>(values: T[], concurrency: number, operation: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await operation(values[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}
