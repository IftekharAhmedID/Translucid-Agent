import {
  adjudicationOutputSchema,
  findingOutputSchema,
  investigationSummarySchema,
  type AdjudicationOutput,
  type FindingOutput,
  type InvestigationSummary,
} from "./contracts.ts";
import { z } from "zod";

const prohibitedDecisionLanguage =
  /\b(candidate\s+score|hire\s+(?:the\s+)?candidate|reject\s+(?:the\s+)?candidate|fraud\s+probability|candidate\s+ranking|hiring\s+recommendation)\b/i;
const protectedTraitLanguage =
  /\b(race|ethnicity|religion|religious|sex|gender|sexual orientation|pregnancy|pregnant|disability|disabled|age|national origin|genetic information)\b/i;
const absenceAsDeception =
  /\b(?:missing|absent|absence|lack(?:ing)?|no evidence)\b.{0,80}\b(?:decepti(?:on|ve)|dishonest(?:y)?|fraud(?:ulent)?|lied|lying)\b/i;

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(collectStrings);
  }
  return [];
}

function assertEvidenceExists(ids: string[], knownEvidenceIds: Set<string>): void {
  for (const id of ids) {
    if (!knownEvidenceIds.has(id)) {
      throw new Error(`Unknown evidence ID ${id}.`);
    }
  }
}

function assertClaimExists(ids: string[], knownClaimIds: Set<string>): void {
  for (const id of ids) {
    if (!knownClaimIds.has(id)) throw new Error(`Unknown claim ID ${id}.`);
  }
}

function assertSafeLanguage(value: unknown): void {
  const strings = collectStrings(value);
  if (strings.some((text) => prohibitedDecisionLanguage.test(text))) throw new Error("Adjudication contains prohibited decision language.");
  if (strings.some((text) => protectedTraitLanguage.test(text))) throw new Error("Adjudication contains protected-trait language.");
  if (strings.some((text) => absenceAsDeception.test(text))) throw new Error("Adjudication describes missing evidence as deception.");
}

export function validateFindingBatch(
  value: unknown,
  requestedClaimIds: Set<string>,
  knownEvidenceIds: Set<string>,
  evidenceClaimIds?: Map<string, Set<string>>,
): FindingOutput[] {
  if (requestedClaimIds.size > 5) throw new Error("A finding batch may contain at most five requested claims.");
  const { findings } = z.object({ findings: z.array(findingOutputSchema).max(5) }).strict().parse(value);
  assertSafeLanguage(findings);
  const findingClaimIds = findings.map(({ claimId }) => claimId);
  assertClaimExists(findingClaimIds, requestedClaimIds);
  if (findingClaimIds.length !== requestedClaimIds.size || new Set(findingClaimIds).size !== findingClaimIds.length) {
    throw new Error("Finding batch must contain exactly one finding for every requested claim.");
  }
  const assertRelevant = (claimId: string, evidenceIds: string[]) => {
    if (!evidenceClaimIds) return;
    for (const evidenceId of evidenceIds) {
      if (!evidenceClaimIds.get(evidenceId)?.has(claimId)) throw new Error(`Evidence ${evidenceId} is not linked to claim ${claimId}.`);
    }
  };
  for (const finding of findings) {
    assertEvidenceExists(finding.supportingEvidenceIds, knownEvidenceIds);
    assertEvidenceExists(finding.contradictingEvidenceIds, knownEvidenceIds);
    assertRelevant(finding.claimId, [...finding.supportingEvidenceIds, ...finding.contradictingEvidenceIds]);
    if (finding.verdict === "CORROBORATED" && finding.supportingEvidenceIds.length === 0) throw new Error(`Claim ${finding.claimId} is corroborated without supporting evidence.`);
    if (finding.verdict === "CONTRADICTED" && finding.contradictingEvidenceIds.length === 0) throw new Error(`Claim ${finding.claimId} is contradicted without contradicting evidence.`);
    if (finding.verdict === "PARTIALLY_CORROBORATED" && finding.supportingEvidenceIds.length === 0) throw new Error(`Claim ${finding.claimId} is partially corroborated without supporting evidence.`);
  }
  return findings;
}

export function validateInvestigationSummary(
  value: unknown,
  knownEvidenceIds: Set<string>,
  knownClaimIds: Set<string>,
  evidenceClaimIds?: Map<string, Set<string>>,
): InvestigationSummary {
  const summary = investigationSummarySchema.parse(value);
  assertSafeLanguage(summary);
  assertEvidenceExists(summary.professionalIdentity.evidenceIds, knownEvidenceIds);
  assertEvidenceExists(summary.strongestEvidenceIds, knownEvidenceIds);
  assertClaimExists(summary.unresolvedMaterialClaimIds, knownClaimIds);
  assertClaimExists(summary.materialInconsistencies.map(({ claimId }) => claimId), knownClaimIds);
  for (const inconsistency of summary.materialInconsistencies) {
    assertEvidenceExists(inconsistency.evidenceIds, knownEvidenceIds);
    if (evidenceClaimIds) {
      for (const evidenceId of inconsistency.evidenceIds) {
        if (!evidenceClaimIds.get(evidenceId)?.has(inconsistency.claimId)) throw new Error(`Evidence ${evidenceId} is not linked to claim ${inconsistency.claimId}.`);
      }
    }
  }
  if (summary.professionalIdentity.status !== "AMBIGUOUS" && summary.professionalIdentity.evidenceIds.length === 0) {
    throw new Error("A resolved or partial professional identity requires evidence.");
  }
  return summary;
}

export function validateAdjudication(
  value: unknown,
  knownEvidenceIds: Set<string>,
  knownClaimIds?: Set<string>,
  evidenceClaimIds?: Map<string, Set<string>>,
): AdjudicationOutput {
  const output = adjudicationOutputSchema.parse(value);
  assertSafeLanguage(output);
  if (knownClaimIds) {
    validateInvestigationSummary(output.summary, knownEvidenceIds, knownClaimIds, evidenceClaimIds);
    const outputClaimIds = output.findings.map(({ claimId }) => claimId);
    assertClaimExists(outputClaimIds, knownClaimIds);
    if (outputClaimIds.length !== knownClaimIds.size || new Set(outputClaimIds).size !== outputClaimIds.length) {
      throw new Error("Adjudication must contain exactly one finding for every durable claim.");
    }
    const claimIds = [...knownClaimIds];
    for (let index = 0; index < claimIds.length; index += 5) {
      const batchIds = new Set(claimIds.slice(index, index + 5));
      validateFindingBatch({ findings: output.findings.filter(({ claimId }) => batchIds.has(claimId)) }, batchIds, knownEvidenceIds, evidenceClaimIds);
    }
  } else {
    assertEvidenceExists(output.summary.professionalIdentity.evidenceIds, knownEvidenceIds);
    assertEvidenceExists(output.summary.strongestEvidenceIds, knownEvidenceIds);
    for (const inconsistency of output.summary.materialInconsistencies) assertEvidenceExists(inconsistency.evidenceIds, knownEvidenceIds);
    for (const finding of output.findings) {
      assertEvidenceExists(finding.supportingEvidenceIds, knownEvidenceIds);
      assertEvidenceExists(finding.contradictingEvidenceIds, knownEvidenceIds);
    }
  }

  return output;
}
