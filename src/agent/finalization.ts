import { z } from "zod";

import {
  findingOutputSchema,
  investigationSummarySchema,
  type FindingOutput,
} from "../core/contracts.ts";

type Row = Record<string, unknown>;

export const criticOutputSchema = z.object({
  acceptedEvidenceIds: z.array(z.uuid()),
  rejectedEvidence: z.array(z.object({ evidenceId: z.uuid(), reason: z.string().min(1).max(2_000) })),
  claimConcerns: z.array(z.object({ claimId: z.uuid(), concerns: z.array(z.string().min(1).max(2_000)) })),
  identityConcerns: z.array(z.string().min(1).max(2_000)),
  chronologyConcerns: z.array(z.string().min(1).max(2_000)),
  limitations: z.array(z.string().min(1).max(2_000)),
}).strict();

export const findingBatchOutputSchema = z.object({
  findings: z.array(findingOutputSchema).max(5),
}).strict();

export const summaryOutputSchema = z.object({
  summary: investigationSummarySchema,
}).strict();

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

function rows(bundle: Record<string, unknown>, key: string): Row[] {
  const value = bundle[key];
  return Array.isArray(value) ? value.filter((row): row is Row => Boolean(row) && typeof row === "object") : [];
}

export function buildFindingBatchBundle(bundle: Record<string, unknown>, claimIds: string[]) {
  const selectedClaims = new Set(claimIds);
  const evidence = rows(bundle, "evidence").filter(({ claimIds: ids }) => Array.isArray(ids) && ids.some((id) => typeof id === "string" && selectedClaims.has(id)));
  const evidenceIds = new Set(evidence.map(({ id }) => String(id)));
  const artifactIds = new Set(evidence.map(({ artifactId }) => String(artifactId)));
  const critic = bundle.critic && typeof bundle.critic === "object" ? bundle.critic as Row : {};
  return {
    claims: rows(bundle, "claims").filter(({ id }) => typeof id === "string" && selectedClaims.has(id)),
    evidence,
    artifacts: rows(bundle, "artifacts").filter(({ id }) => artifactIds.has(String(id))),
    observations: rows(bundle, "observations").filter(({ artifactId }) => artifactIds.has(String(artifactId))),
    researchQuestions: rows(bundle, "researchQuestions").filter(({ claimIds: ids }) => Array.isArray(ids) && ids.some((id) => typeof id === "string" && selectedClaims.has(id))),
    claimConcerns: Array.isArray(critic.claimConcerns)
      ? critic.claimConcerns.filter((concern) => Boolean(concern) && typeof concern === "object" && selectedClaims.has(String((concern as Row).claimId)))
      : [],
    limitations: Array.isArray(critic.limitations) ? critic.limitations : [],
    evidenceIds: [...evidenceIds],
  };
}

export function buildSummaryBundle(bundle: Record<string, unknown>, findings: FindingOutput[]) {
  const critic = bundle.critic && typeof bundle.critic === "object" ? bundle.critic as Row : {};
  return {
    validatedFindings: findings,
    acceptedEvidence: rows(bundle, "evidence"),
    entityResolution: {
      entities: rows(bundle, "entities"),
      identifiers: rows(bundle, "identifiers"),
      links: rows(bundle, "links"),
    },
    observations: rows(bundle, "observations"),
    capabilityLimitations: Array.isArray(critic.limitations) ? critic.limitations : [],
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
