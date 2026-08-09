import {
  adjudicationOutputSchema,
  type AdjudicationOutput,
} from "./contracts.ts";

const prohibitedDecisionLanguage =
  /\b(candidate\s+score|hire\s+(?:the\s+)?candidate|reject\s+(?:the\s+)?candidate|fraud\s+probability|candidate\s+ranking|hiring\s+recommendation)\b/i;

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

export function validateAdjudication(
  value: unknown,
  knownEvidenceIds: Set<string>,
): AdjudicationOutput {
  const output = adjudicationOutputSchema.parse(value);
  if (collectStrings(output).some((text) => prohibitedDecisionLanguage.test(text))) {
    throw new Error("Adjudication contains prohibited decision language.");
  }

  assertEvidenceExists(output.summary.professionalIdentity.evidenceIds, knownEvidenceIds);
  assertEvidenceExists(output.summary.strongestEvidenceIds, knownEvidenceIds);
  for (const inconsistency of output.summary.materialInconsistencies) {
    assertEvidenceExists(inconsistency.evidenceIds, knownEvidenceIds);
  }

  for (const finding of output.findings) {
    assertEvidenceExists(finding.supportingEvidenceIds, knownEvidenceIds);
    assertEvidenceExists(finding.contradictingEvidenceIds, knownEvidenceIds);
    if (finding.verdict === "CORROBORATED" && finding.supportingEvidenceIds.length === 0) {
      throw new Error(`Claim ${finding.claimId} is corroborated without supporting evidence.`);
    }
    if (finding.verdict === "CONTRADICTED" && finding.contradictingEvidenceIds.length === 0) {
      throw new Error(`Claim ${finding.claimId} is contradicted without contradicting evidence.`);
    }
  }

  return output;
}
