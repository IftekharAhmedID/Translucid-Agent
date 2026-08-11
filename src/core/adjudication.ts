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

export function assertSafeInvestigationLanguage(value: unknown): void {
  assertSafeLanguage(value);
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

export function repairFacetFindingBatch(
  value: unknown,
  knownEvidenceIds: Set<string>,
  evidenceClaimIds: Map<string, Set<string>>,
  claimFacets: Map<string, ClaimFacet[]>,
  evidenceRelations: Map<string, "SUPPORTS" | "CONTRADICTS" | "CONTEXT">,
  evidenceFacetKeys: Map<string, Set<string>>,
): unknown {
  const parsed = z.object({ findings: z.array(findingOutputSchema).max(5) }).strict().parse(value);
  const repairedFindings = parsed.findings.map((finding) => {
    const facets = claimFacets.get(finding.claimId) ?? [];
    let repaired = false;
    const facetNotes = finding.facetNotes.map((note) => {
      const eligible = [...knownEvidenceIds].filter((evidenceId) => (
        evidenceClaimIds.get(evidenceId)?.has(finding.claimId)
        && evidenceFacetKeys.get(evidenceId)?.has(note.facetKey)
        && (evidenceRelations.get(evidenceId) === "SUPPORTS" || evidenceRelations.get(evidenceId) === "CONTRADICTS")
      ));
      const contradictionIds = eligible.filter((evidenceId) => evidenceRelations.get(evidenceId) === "CONTRADICTS");
      const supportIds = eligible.filter((evidenceId) => evidenceRelations.get(evidenceId) === "SUPPORTS");
      if (note.evidenceIds.length > 0 || (note.status !== "UNRESOLVED" && eligible.length === 0)) return note;
      const evidenceIds = contradictionIds.length > 0 ? contradictionIds : supportIds;
      if (!evidenceIds.length) return note;
      repaired = true;
      const status = contradictionIds.length > 0 ? "CONTRADICTED" as const : "SUPPORTED" as const;
      return {
        ...note,
        status,
        evidenceIds,
        note: `${note.note} Backend retained accepted ${status.toLowerCase()} evidence for this facet.`,
      };
    });
    if (!repaired) return finding;
    const supportingEvidenceIds = [...new Set([
      ...finding.supportingEvidenceIds,
      ...facetNotes.filter((note) => note.status === "SUPPORTED").flatMap((note) => note.evidenceIds),
    ])];
    const contradictingEvidenceIds = [...new Set([
      ...finding.contradictingEvidenceIds,
      ...facetNotes.filter((note) => note.status === "CONTRADICTED").flatMap((note) => note.evidenceIds),
    ])];
    const materialContradiction = facetNotes.some((note) => note.status === "CONTRADICTED" && facets.find((facet) => facet.key === note.facetKey)?.materiality !== "LOW");
    const allSupported = facetNotes.length > 0 && facetNotes.every((note) => note.status === "SUPPORTED");
    const allUnresolved = facetNotes.every((note) => note.status === "UNRESOLVED");
    const verdict = materialContradiction ? "CONTRADICTED" : allSupported ? "CORROBORATED" : allUnresolved ? "UNRESOLVED" : "PARTIALLY_CORROBORATED";
    return {
      ...finding,
      verdict,
      supportingEvidenceIds,
      contradictingEvidenceIds,
      facetNotes,
      explanation: `${finding.explanation} Deterministic facet alignment retained accepted evidence where the model omitted it.`,
    };
  });
  return { findings: repairedFindings };
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
    if (note.status === "UNRESOLVED" && [...knownEvidenceIds].some((evidenceId) => (
      evidenceClaimIds?.get(evidenceId)?.has(finding.claimId)
      && (evidenceRelations?.get(evidenceId) === "SUPPORTS" || evidenceRelations?.get(evidenceId) === "CONTRADICTS")
      && evidenceFacetKeys?.get(evidenceId)?.has(note.facetKey)
    ))) {
      throw new Error(`Facet ${note.facetKey} is unresolved despite eligible evidence.`);
    }
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
  evidenceRelations?: Map<string, "SUPPORTS" | "CONTRADICTS" | "CONTEXT">,
  evidenceFacetKeys?: Map<string, Set<string>>,
  claimFacets?: Map<string, ClaimFacet[]>,
): InvestigationSummary {
  const summary = investigationSummarySchema.parse(value);
  assertSafeLanguage(summary);
  assertHonestSourceLanguage(summary, sourceAuthorityCounts);
  assertEvidenceExists(summary.professionalIdentity.evidenceIds, knownEvidenceIds);
  assertEvidenceExists(summary.professionalTimelineEvidenceIds, knownEvidenceIds);
  assertEvidenceExists(summary.strongestEvidenceIds, knownEvidenceIds);
  assertClaimExists(summary.professionalIdentityClaimIds, knownClaimIds);
  assertClaimExists(summary.professionalTimelineClaimIds, knownClaimIds);
  for (const item of summary.strongestEvidenceByClaim) {
    assertClaimExists([item.claimId], knownClaimIds);
    assertSummaryEvidenceBelongs(item.evidenceIds, item.claimId, evidenceClaimIds, evidenceRelations);
    if (claimFacets && evidenceFacetKeys) {
      const declared = new Set((claimFacets.get(item.claimId) ?? []).map(({ key }) => key));
      for (const facetKey of item.facetKeys) {
        if (!declared.has(facetKey)) throw new Error(`Summary strongest evidence referenced unknown facet ${facetKey}.`);
      }
      for (const evidenceId of item.evidenceIds) {
        if (item.facetKeys.length === 0 || !item.facetKeys.some((facetKey) => evidenceFacetKeys.get(evidenceId)?.has(facetKey))) {
          throw new Error(`Summary strongest evidence ${evidenceId} is not mapped to a declared facet.`);
        }
      }
    }
  }
  assertSummaryEvidenceForClaimSet(summary.professionalIdentity.evidenceIds, summary.professionalIdentityClaimIds, evidenceClaimIds, evidenceRelations, "professional identity");
  assertSummaryEvidenceForClaimSet(summary.professionalTimelineEvidenceIds, summary.professionalTimelineClaimIds, evidenceClaimIds, evidenceRelations, "professional timeline");
  if (evidenceClaimIds && summary.strongestEvidenceIds.some((evidenceId) => !summary.strongestEvidenceByClaim.some((item) => item.evidenceIds.includes(evidenceId)))) {
    throw new Error("Every strongest evidence ID must belong to a claim-scoped strongestEvidenceByClaim mapping.");
  }
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

function assertSummaryEvidenceBelongs(
  evidenceIds: string[],
  claimId: string,
  evidenceClaimIds?: Map<string, Set<string>>,
  evidenceRelations?: Map<string, "SUPPORTS" | "CONTRADICTS" | "CONTEXT">,
): void {
  if (!evidenceClaimIds) return;
  for (const evidenceId of evidenceIds) {
    if (!evidenceClaimIds.get(evidenceId)?.has(claimId)) throw new Error(`Summary evidence ${evidenceId} is not linked to claim ${claimId}.`);
    if (evidenceRelations?.get(evidenceId) === "CONTEXT") throw new Error(`Summary evidence ${evidenceId} is CONTEXT and cannot be cited.`);
  }
}

function assertSummaryEvidenceForClaimSet(
  evidenceIds: string[],
  claimIds: string[],
  evidenceClaimIds: Map<string, Set<string>> | undefined,
  evidenceRelations: Map<string, "SUPPORTS" | "CONTRADICTS" | "CONTEXT"> | undefined,
  label: string,
): void {
  if (!evidenceClaimIds) return;
  const allowedClaims = new Set(claimIds);
  for (const evidenceId of evidenceIds) {
    const linkedClaims = evidenceClaimIds.get(evidenceId) ?? new Set<string>();
    if (![...linkedClaims].some((claimId) => allowedClaims.has(claimId))) throw new Error(`${label} evidence ${evidenceId} is outside its declared claim mapping.`);
    if (evidenceRelations?.get(evidenceId) === "CONTEXT") throw new Error(`${label} evidence ${evidenceId} is CONTEXT and cannot be cited.`);
  }
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
    validateInvestigationSummary(output.summary, knownEvidenceIds, knownClaimIds, evidenceClaimIds, sourceAuthorityCounts, evidenceRelations, evidenceFacetKeys, claimFacets);
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
