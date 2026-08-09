import {
  adjudicationOutputSchema,
  type AdjudicationOutput,
} from "./contracts.ts";

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

export function validateAdjudication(
  value: unknown,
  knownEvidenceIds: Set<string>,
  knownClaimIds?: Set<string>,
  evidenceClaimIds?: Map<string, Set<string>>,
): AdjudicationOutput {
  const output = adjudicationOutputSchema.parse(value);
  const strings = collectStrings(output);
  if (strings.some((text) => prohibitedDecisionLanguage.test(text))) {
    throw new Error("Adjudication contains prohibited decision language.");
  }
  if (strings.some((text) => protectedTraitLanguage.test(text))) throw new Error("Adjudication contains protected-trait language.");
  if (strings.some((text) => absenceAsDeception.test(text))) throw new Error("Adjudication describes missing evidence as deception.");

  assertEvidenceExists(output.summary.professionalIdentity.evidenceIds, knownEvidenceIds);
  assertEvidenceExists(output.summary.strongestEvidenceIds, knownEvidenceIds);
  for (const inconsistency of output.summary.materialInconsistencies) {
    assertEvidenceExists(inconsistency.evidenceIds, knownEvidenceIds);
  }
  if (knownClaimIds) {
    assertClaimExists(output.summary.unresolvedMaterialClaimIds, knownClaimIds);
    assertClaimExists(output.summary.materialInconsistencies.map(({ claimId }) => claimId), knownClaimIds);
    assertClaimExists(output.findings.map(({ claimId }) => claimId), knownClaimIds);
    const findingClaimIds = output.findings.map(({ claimId }) => claimId);
    if (findingClaimIds.length !== knownClaimIds.size || new Set(findingClaimIds).size !== findingClaimIds.length || findingClaimIds.some((id) => !knownClaimIds.has(id))) {
      throw new Error("Adjudication must contain exactly one finding for every durable claim.");
    }
  }

  if (output.summary.professionalIdentity.status !== "AMBIGUOUS" && output.summary.professionalIdentity.evidenceIds.length === 0) {
    throw new Error("A resolved or partial professional identity requires evidence.");
  }

  const assertRelevant = (claimId: string, evidenceIds: string[]) => {
    if (!evidenceClaimIds) return;
    for (const evidenceId of evidenceIds) {
      if (!evidenceClaimIds.get(evidenceId)?.has(claimId)) throw new Error(`Evidence ${evidenceId} is not linked to claim ${claimId}.`);
    }
  };
  for (const inconsistency of output.summary.materialInconsistencies) assertRelevant(inconsistency.claimId, inconsistency.evidenceIds);

  for (const finding of output.findings) {
    assertEvidenceExists(finding.supportingEvidenceIds, knownEvidenceIds);
    assertEvidenceExists(finding.contradictingEvidenceIds, knownEvidenceIds);
    assertRelevant(finding.claimId, [...finding.supportingEvidenceIds, ...finding.contradictingEvidenceIds]);
    if (finding.verdict === "CORROBORATED" && finding.supportingEvidenceIds.length === 0) {
      throw new Error(`Claim ${finding.claimId} is corroborated without supporting evidence.`);
    }
    if (finding.verdict === "CONTRADICTED" && finding.contradictingEvidenceIds.length === 0) {
      throw new Error(`Claim ${finding.claimId} is contradicted without contradicting evidence.`);
    }
    if (finding.verdict === "PARTIALLY_CORROBORATED" && finding.supportingEvidenceIds.length === 0) {
      throw new Error(`Claim ${finding.claimId} is partially corroborated without supporting evidence.`);
    }
  }

  return output;
}
