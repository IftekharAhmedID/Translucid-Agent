import {
  adjudicationOutputSchema,
  findingOutputSchema,
  investigationSummarySchema,
  type AdjudicationOutput,
  type ClaimFacet,
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

function assertHonestSourceLanguage(value: unknown, sourceAuthorityCounts?: Record<string, number>): void {
  if (!sourceAuthorityCounts) return;
  const total = Object.values(sourceAuthorityCounts).reduce((sum, count) => sum + count, 0);
  const selfOnly = total > 0 && Object.entries(sourceAuthorityCounts).every(([authority, count]) => authority === "SELF_REPRESENTATION" ? count > 0 : count === 0);
  if (!selfOnly && collectStrings(value).some((text) => /(?:all|every|the entire)\s+(?:captured\s+)?evidence\s+(?:is|remains)\s+self[- ]represent/i.test(text))) {
    throw new Error("Summary overstates source authority as self-representational without backend counts proving it.");
  }
}

export function validateFindingBatch(
  value: unknown,
  requestedClaimIds: Set<string>,
  knownEvidenceIds: Set<string>,
  evidenceClaimIds?: Map<string, Set<string>>,
  claimFacets?: Map<string, ClaimFacet[]>,
  evidenceRelations?: Map<string, "SUPPORTS" | "CONTRADICTS" | "CONTEXT">,
  evidenceFacetKeys?: Map<string, Set<string>>,
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
    assertEvidenceRelations(finding.supportingEvidenceIds, "SUPPORTS", evidenceRelations);
    assertEvidenceRelations(finding.contradictingEvidenceIds, "CONTRADICTS", evidenceRelations);
    assertRelevant(finding.claimId, [...finding.supportingEvidenceIds, ...finding.contradictingEvidenceIds]);
    const facets = claimFacets?.get(finding.claimId);
    if (facets?.length) validateFacetVerdict(finding, facets, knownEvidenceIds, evidenceClaimIds, evidenceRelations, evidenceFacetKeys);
    if (finding.verdict === "CORROBORATED" && finding.supportingEvidenceIds.length === 0) throw new Error(`Claim ${finding.claimId} is corroborated without supporting evidence.`);
    if (finding.verdict === "CONTRADICTED" && finding.contradictingEvidenceIds.length === 0) throw new Error(`Claim ${finding.claimId} is contradicted without contradicting evidence.`);
    if (finding.verdict === "PARTIALLY_CORROBORATED" && finding.supportingEvidenceIds.length === 0) throw new Error(`Claim ${finding.claimId} is partially corroborated without supporting evidence.`);
    if (finding.verdict === "UNRESOLVED" && (finding.supportingEvidenceIds.length > 0 || finding.contradictingEvidenceIds.length > 0)) throw new Error(`Claim ${finding.claimId} is unresolved but cites supporting or contradicting evidence.`);
  }
  return findings;
}

function validateFacetVerdict(
  finding: FindingOutput,
  facets: ClaimFacet[],
  knownEvidenceIds: Set<string>,
  evidenceClaimIds?: Map<string, Set<string>>,
  evidenceRelations?: Map<string, "SUPPORTS" | "CONTRADICTS" | "CONTEXT">,
  evidenceFacetKeys?: Map<string, Set<string>>,
): void {
  const facetByKey = new Map(facets.map((facet) => [facet.key, facet]));
  if (finding.facetNotes.length !== facets.length || new Set(finding.facetNotes.map((note) => note.facetKey)).size !== facets.length) {
    throw new Error(`Finding ${finding.claimId} must describe every declared claim facet exactly once.`);
  }
  for (const note of finding.facetNotes) {
    const facet = facetByKey.get(note.facetKey);
    if (!facet) throw new Error(`Finding ${finding.claimId} referenced unknown facet ${note.facetKey}.`);
    assertEvidenceExists(note.evidenceIds, knownEvidenceIds);
    assertRelevant(finding.claimId, note.evidenceIds, evidenceClaimIds);
    const allowed = note.status === "SUPPORTED" ? finding.supportingEvidenceIds : note.status === "CONTRADICTED" ? finding.contradictingEvidenceIds : [];
    assertEvidenceRelations(note.evidenceIds, note.status === "SUPPORTED" ? "SUPPORTS" : "CONTRADICTS", evidenceRelations);
    if ((note.status === "SUPPORTED" || note.status === "CONTRADICTED") && note.evidenceIds.length === 0) {
      throw new Error(`Facet ${note.facetKey} is ${note.status} without matching evidence.`);
    }
    for (const evidenceId of note.evidenceIds) {
      if (!allowed.includes(evidenceId)) throw new Error(`Facet ${note.facetKey} cited evidence ${evidenceId} in the wrong relation.`);
      if (evidenceFacetKeys && !evidenceFacetKeys.get(evidenceId)?.has(note.facetKey)) {
        throw new Error(`Facet ${note.facetKey} cited evidence ${evidenceId} without a matching facet key.`);
      }
    }
    if (note.status === "UNRESOLVED" && note.evidenceIds.length > 0) throw new Error(`Unresolved facet ${note.facetKey} cannot cite supporting or contradicting evidence.`);
  }
  const materialContradiction = finding.facetNotes.some((note) => note.status === "CONTRADICTED" && facetByKey.get(note.facetKey)?.materiality !== "LOW");
  const allSupported = finding.facetNotes.every((note) => note.status === "SUPPORTED");
  const allUnresolved = finding.facetNotes.every((note) => note.status === "UNRESOLVED");
  const expected = materialContradiction ? "CONTRADICTED" : allSupported ? "CORROBORATED" : allUnresolved ? "UNRESOLVED" : "PARTIALLY_CORROBORATED";
    if (finding.verdict !== expected) throw new Error(`Finding ${finding.claimId} verdict ${finding.verdict} does not match facet outcome ${expected}.`);
}

function assertRelevant(claimId: string, evidenceIds: string[], evidenceClaimIds?: Map<string, Set<string>>): void {
  if (!evidenceClaimIds) return;
  for (const evidenceId of evidenceIds) {
    if (!evidenceClaimIds.get(evidenceId)?.has(claimId)) throw new Error(`Evidence ${evidenceId} is not linked to claim ${claimId}.`);
  }
}

function assertEvidenceRelations(
  evidenceIds: string[],
  relation: "SUPPORTS" | "CONTRADICTS",
  evidenceRelations?: Map<string, "SUPPORTS" | "CONTRADICTS" | "CONTEXT">,
): void {
  if (!evidenceRelations) return;
  for (const evidenceId of evidenceIds) {
    if (evidenceRelations.get(evidenceId) !== relation) throw new Error(`Evidence ${evidenceId} is not a ${relation} edge.`);
  }
}

export function validateInvestigationSummary(
  value: unknown,
  knownEvidenceIds: Set<string>,
  knownClaimIds: Set<string>,
  evidenceClaimIds?: Map<string, Set<string>>,
  sourceAuthorityCounts?: Record<string, number>,
): InvestigationSummary {
  const summary = investigationSummarySchema.parse(value);
  assertSafeLanguage(summary);
  assertHonestSourceLanguage(summary, sourceAuthorityCounts);
  assertEvidenceExists(summary.professionalIdentity.evidenceIds, knownEvidenceIds);
  assertEvidenceExists(summary.professionalTimelineEvidenceIds, knownEvidenceIds);
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
  const timelineIsExplicitlyUnresolved = /^(?:no|the saved observations? do not|observations? do not)/i.test(summary.professionalTimelineSummary.trim());
  if (!timelineIsExplicitlyUnresolved && summary.professionalTimelineEvidenceIds.length === 0) {
    throw new Error("A professional timeline summary requires evidence.");
  }
  return summary;
}

export function validateAdjudication(
  value: unknown,
  knownEvidenceIds: Set<string>,
  knownClaimIds?: Set<string>,
  evidenceClaimIds?: Map<string, Set<string>>,
  claimFacets?: Map<string, ClaimFacet[]>,
  evidenceRelations?: Map<string, "SUPPORTS" | "CONTRADICTS" | "CONTEXT">,
  sourceAuthorityCounts?: Record<string, number>,
  evidenceFacetKeys?: Map<string, Set<string>>,
): AdjudicationOutput {
  const output = adjudicationOutputSchema.parse(value);
  assertSafeLanguage(output);
  if (knownClaimIds) {
    validateInvestigationSummary(output.summary, knownEvidenceIds, knownClaimIds, evidenceClaimIds, sourceAuthorityCounts);
    const outputClaimIds = output.findings.map(({ claimId }) => claimId);
    assertClaimExists(outputClaimIds, knownClaimIds);
    if (outputClaimIds.length !== knownClaimIds.size || new Set(outputClaimIds).size !== outputClaimIds.length) {
      throw new Error("Adjudication must contain exactly one finding for every durable claim.");
    }
    const claimIds = [...knownClaimIds];
    for (let index = 0; index < claimIds.length; index += 5) {
      const batchIds = new Set(claimIds.slice(index, index + 5));
      validateFindingBatch({ findings: output.findings.filter(({ claimId }) => batchIds.has(claimId)) }, batchIds, knownEvidenceIds, evidenceClaimIds, claimFacets, evidenceRelations, evidenceFacetKeys);
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
