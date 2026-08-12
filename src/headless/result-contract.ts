import { z } from "zod";

import { assertSafeInvestigationLanguage } from "../core/adjudication.ts";
import { facetEvidenceCompatible } from "../core/evidence-fit.ts";
import { auditClaimFacetCoverage } from "../core/facet-coverage.ts";
import { effectiveAttestationGroup, effectiveSourceAuthority, type SourceAuthority } from "../core/source-trust.ts";
import type { FileSourceStore } from "./source-store.ts";

const key = z.string().min(1).max(200);
const facetKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const materiality = z.enum(["HIGH", "MEDIUM", "LOW"]);
const facetStatus = z.string().min(1).max(100);
const sourceLocation = z.object({ path: z.string().min(1).max(2_000) }).catchall(z.unknown());

export const investigationDraftSchema = z.object({
  summary: z.object({
    professionalIdentity: z.object({
      status: z.enum(["RESOLVED", "PARTIAL", "AMBIGUOUS"]),
      text: z.string().min(1).max(4_000),
      claimKeys: z.array(key).max(100),
      evidenceKeys: z.array(key).max(100),
    }).strict(),
    professionalTimelineSummary: z.string().min(1).max(8_000),
    timelineClaimKeys: z.array(key).max(100),
    timelineEvidenceKeys: z.array(key).max(100),
    strongestEvidenceByClaim: z.array(z.object({
      claimKey: key,
      facetKeys: z.array(facetKey).min(1).max(12),
      evidenceKeys: z.array(key).max(100),
    }).strict()).max(100),
    materialInconsistencies: z.array(z.object({
      claimKey: key,
      text: z.string().min(1).max(4_000),
      evidenceKeys: z.array(key).min(1).max(100),
    }).strict()).max(100),
    limitations: z.array(z.string().min(1).max(2_000)).max(100),
  }).strict(),
  claims: z.array(z.object({
    key,
    category: z.enum(["IDENTITY", "EMPLOYMENT", "PROJECT", "CONTRIBUTION", "EDUCATION", "EVENT", "PUBLICATION", "AFFILIATION", "OTHER"]),
    statement: z.string().min(1).max(8_000),
    materiality,
    sourceSpan: z.object({ page: z.number().int().positive().optional(), text: z.string().min(1).max(20_000) }).strict(),
    explanation: z.string().min(1).max(8_000),
    facets: z.array(z.object({
      key: facetKey,
      label: z.string().min(1).max(500),
      materiality,
      status: facetStatus,
      note: z.string().min(1).max(2_000),
    }).strict()).min(1).max(12),
  }).strict()).min(1).max(500),
  evidence: z.array(z.object({
    key,
    claimKey: key,
    facetKeys: z.array(facetKey).min(1).max(12),
    relation: z.enum(["SUPPORTS", "CONTRADICTS"]),
    sourceRef: z.string().regex(/^S[1-9]\d*$/),
    exactQuote: z.string().min(1).max(80_000),
    sourceLocation,
  }).strict()).max(5_000),
  timeline: z.array(z.object({
    label: z.string().min(1).max(1_000),
    validFrom: z.string().min(1).optional(),
    validTo: z.string().min(1).optional(),
    claimKeys: z.array(key).min(1).max(100),
    evidenceKeys: z.array(key).max(100),
  }).strict()).max(500),
}).strict();

export type InvestigationDraft = z.infer<typeof investigationDraftSchema>;
type EvidenceStrength = "STRONG" | "MODERATE" | "WEAK";

export type InvestigationResult = {
  schemaVersion: "1.1";
  run: {
    id: string;
    status: "COMPLETED" | "COMPLETED_WITH_LIMITATIONS";
    runtime: "LOCAL" | "E2B";
    startedAt: string;
    finishedAt: string;
    inputSha256: string;
    classification: "SYNTHETIC" | "PUBLIC_PROFESSIONAL";
    models: { research: string; compiler: string; auditor: string };
    budgets: { modelUsd: number; providerUsd: number; externalNetworkCalls: number };
  };
  summary: {
    professionalIdentity: { status: "RESOLVED" | "PARTIAL" | "AMBIGUOUS"; text: string; claimIds: string[]; evidenceIds: string[] };
    professionalTimelineSummary: string;
    timelineClaimIds: string[];
    timelineEvidenceIds: string[];
    strongestEvidenceByClaim: Array<{ claimId: string; facetKeys: string[]; evidenceIds: string[] }>;
    materialInconsistencies: Array<{ claimId: string; text: string; evidenceIds: string[] }>;
    limitations: string[];
  };
  claims: Array<{
    id: string;
    category: InvestigationDraft["claims"][number]["category"];
    statement: string;
    materiality: InvestigationDraft["claims"][number]["materiality"];
    sourceSpan: { page?: number; text: string };
    verdict: "CORROBORATED" | "PARTIALLY_CORROBORATED" | "CONTRADICTED" | "UNRESOLVED";
    strength: EvidenceStrength | null;
    explanation: string;
    facets: Array<{
      key: string;
      label: string;
      materiality: "HIGH" | "MEDIUM" | "LOW";
      status: "SUPPORTED" | "CONTRADICTED" | "UNRESOLVED";
      strength: EvidenceStrength | null;
      evidenceIds: string[];
      note: string;
    }>;
  }>;
  evidence: Array<{
    id: string;
    claimId: string;
    facetKeys: string[];
    relation: "SUPPORTS" | "CONTRADICTS";
    sourceRef: string;
    exactQuote: string;
    sourceLocation: Record<string, unknown>;
    sourceAuthority: Exclude<SourceAuthority, "CONTEXT" | "DISCOVERY_ONLY">;
    independenceGroup: string;
    attestationGroup: string;
  }>;
  timeline: Array<{
    label: string;
    validFrom?: string;
    validTo?: string;
    state: "REPORTED" | "SUPPORTED_SELF" | "CORROBORATED" | "CONFLICTING";
    claimIds: string[];
    evidenceIds: string[];
  }>;
  sources: Array<{
    ref: string;
    kind: string;
    url?: string;
    title?: string;
    provider: string;
    providerRoute: string;
    retrievedAt: string;
    sha256: string;
    byteLength: number;
    mimeType: string;
    sourceAuthority: string;
    independenceGroup: string;
    attestationGroup: string;
    relativePath: string;
  }>;
  audit: {
    status: "PASSED";
    compilerAttempts: 1 | 2;
    auditorAttempts: 1 | 2;
    warnings: string[];
    statistics: {
      claims: number;
      facets: number;
      evidence: number;
      sources: number;
      rejectedCitations: number;
      sourceAuthorityCounts: Record<string, number>;
      providerCalls: number;
      cacheHits: number;
    };
  };
};

type ResultContext = {
  run: Omit<InvestigationResult["run"], "status">;
  sourceStore: FileSourceStore;
  compilerAttempts: 1 | 2;
  auditorAttempts: 1 | 2;
  warnings?: string[];
  rejectedCitations?: number;
  providerCalls?: number;
  cacheHits?: number;
};

function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}.`);
}

function compareClaims(left: InvestigationDraft["claims"][number], right: InvestigationDraft["claims"][number]): number {
  // The dossier compiler freezes claims in résumé order. Preserve that order
  // within a page; only page order is a deterministic fallback for legacy
  // drafts that did not arrive in source order.
  return (left.sourceSpan.page ?? Number.MAX_SAFE_INTEGER) - (right.sourceSpan.page ?? Number.MAX_SAFE_INTEGER);
}

function expectedFacetStatus(relations: Array<"SUPPORTS" | "CONTRADICTS">): "SUPPORTED" | "CONTRADICTED" | "UNRESOLVED" {
  if (relations.includes("CONTRADICTS")) return "CONTRADICTED";
  if (relations.includes("SUPPORTS")) return "SUPPORTED";
  return "UNRESOLVED";
}

function verdict(facets: Array<{ materiality: "HIGH" | "MEDIUM" | "LOW"; status: "SUPPORTED" | "CONTRADICTED" | "UNRESOLVED" }>): InvestigationResult["claims"][number]["verdict"] {
  if (facets.some((facet) => facet.status === "CONTRADICTED" && facet.materiality !== "LOW")) return "CONTRADICTED";
  if (facets.every((facet) => facet.status === "SUPPORTED")) return "CORROBORATED";
  if (facets.every((facet) => facet.status === "UNRESOLVED")) return "UNRESOLVED";
  if (facets.some((facet) => facet.status === "SUPPORTED")) return "PARTIALLY_CORROBORATED";
  return "CONTRADICTED";
}

function evidenceStrength(evidence: Array<{ sourceAuthority: Exclude<SourceAuthority, "CONTEXT" | "DISCOVERY_ONLY">; attestationGroup: string }>): EvidenceStrength {
  if (evidence.some((item) => item.sourceAuthority === "DIRECT_WORK")) return "STRONG";
  const nonCandidateGroups = new Set(evidence
    .filter((item) => item.attestationGroup !== "CANDIDATE_SELF")
    .map((item) => item.attestationGroup));
  if (nonCandidateGroups.size >= 2) return "STRONG";
  if (evidence.some((item) => item.sourceAuthority === "FIRST_PARTY_INSTITUTIONAL" || item.sourceAuthority === "INDEPENDENT_PROFESSIONAL")) return "MODERATE";
  return "WEAK";
}

function materialFloorStrength(facets: Array<{ materiality: "HIGH" | "MEDIUM" | "LOW"; strength: EvidenceStrength | null }>): EvidenceStrength | null {
  const resolved = facets.filter((facet): facet is typeof facet & { strength: EvidenceStrength } => facet.strength !== null);
  const tier = (["HIGH", "MEDIUM", "LOW"] as const).find((materialityValue) => resolved.some((facet) => facet.materiality === materialityValue));
  if (!tier) return null;
  const strengths = resolved.filter((facet) => facet.materiality === tier).map((facet) => facet.strength);
  return strengths.includes("WEAK") ? "WEAK" : strengths.includes("MODERATE") ? "MODERATE" : "STRONG";
}

function timelineState(evidence: InvestigationResult["evidence"]): InvestigationResult["timeline"][number]["state"] {
  if (evidence.some((item) => item.relation === "CONTRADICTS")) return "CONFLICTING";
  if (evidence.length === 0) return "REPORTED";
  return evidence.every((item) => item.attestationGroup === "CANDIDATE_SELF") ? "SUPPORTED_SELF" : "CORROBORATED";
}

function mapKnown(values: string[], mapping: Map<string, string>, label: string): string[] {
  return values.map((value) => {
    const mapped = mapping.get(value);
    if (!mapped) throw new Error(`Unknown ${label} ${value}.`);
    return mapped;
  });
}

export async function canonicalizeInvestigationResult(value: unknown, context: ResultContext): Promise<InvestigationResult> {
  const draft = investigationDraftSchema.parse(value);
  assertSafeInvestigationLanguage(draft);
  unique(draft.claims.map((claim) => claim.key), "claim key");
  unique(draft.evidence.map((item) => item.key), "evidence key");
  for (const claim of draft.claims) {
    unique(claim.facets.map((facet) => facet.key), `facet key on claim ${claim.key}`);
    const coverage = auditClaimFacetCoverage(claim.statement, claim.facets);
    if (!coverage.complete) throw new Error(`Material claim clause has no declared facet on ${claim.key}: ${coverage.uncovered.map(({ clause }) => clause).join(" | ")}`);
  }

  const sortedClaims = [...draft.claims].sort(compareClaims);
  const claimIds = new Map(sortedClaims.map((claim, index) => [claim.key, `C${index + 1}`]));
  const claimByKey = new Map(sortedClaims.map((claim) => [claim.key, claim]));
  const sources = await context.sourceStore.list();
  const sourceByRef = new Map(sources.map((source) => [source.ref, source]));

  const preparedEvidence = [] as Array<InvestigationDraft["evidence"][number] & {
    sourceAuthority: Exclude<SourceAuthority, "CONTEXT" | "DISCOVERY_ONLY">;
    independenceGroup: string;
    attestationGroup: string;
    claimOrder: number;
    facetOrder: number;
  }>;
  for (const item of draft.evidence) {
    const claim = claimByKey.get(item.claimKey);
    if (!claim) throw new Error(`Unknown claim key ${item.claimKey} on evidence ${item.key}.`);
    const declared = new Map(claim.facets.map((facet, index) => [facet.key, { facet, index }]));
    unique(item.facetKeys, `facet key on evidence ${item.key}`);
    for (const keyValue of item.facetKeys) {
      const entry = declared.get(keyValue);
      if (!entry) throw new Error(`Evidence ${item.key} references unknown facet ${keyValue} on claim ${claim.key}.`);
      if (!facetEvidenceCompatible(item.exactQuote, entry.facet.label)) throw new Error(`Evidence ${item.key} quote is incompatible with facet ${keyValue}.`);
    }
    const source = sourceByRef.get(item.sourceRef);
    if (!source) throw new Error(`Evidence ${item.key} references unknown source ${item.sourceRef}.`);
    const sourceAuthority = effectiveSourceAuthority({ artifact: source });
    if (sourceAuthority === "CONTEXT" || sourceAuthority === "DISCOVERY_ONLY") throw new Error(`${sourceAuthority} source ${source.ref} cannot be cited as evidence.`);
    const excerpt = await context.sourceStore.excerpts({ sourceRef: source.ref, queries: [item.exactQuote], maxCharacters: Math.min(80_000, item.exactQuote.length + 2_000) });
    if (!excerpt.excerpts.some(({ path, text }) => path === item.sourceLocation.path && text.includes(item.exactQuote))) {
      throw new Error(`Evidence ${item.key} exact quote is not present at source location ${item.sourceLocation.path} in immutable source ${source.ref}.`);
    }
    preparedEvidence.push({
      ...item,
      sourceAuthority,
      independenceGroup: source.independenceGroup,
      attestationGroup: effectiveAttestationGroup({ artifact: source }),
      claimOrder: sortedClaims.indexOf(claim),
      facetOrder: Math.min(...item.facetKeys.map((keyValue) => declared.get(keyValue)!.index)),
    });
  }

  preparedEvidence.sort((left, right) => left.claimOrder - right.claimOrder
    || left.facetOrder - right.facetOrder
    || left.relation.localeCompare(right.relation)
    || Number(left.sourceRef.slice(1)) - Number(right.sourceRef.slice(1))
    || left.exactQuote.localeCompare(right.exactQuote));
  const evidenceIds = new Map(preparedEvidence.map((item, index) => [item.key, `E${index + 1}`]));
  const evidenceByKey = new Map(preparedEvidence.map((item) => [item.key, item]));
  const evidence: InvestigationResult["evidence"] = preparedEvidence.map((item) => ({
    id: evidenceIds.get(item.key)!,
    claimId: claimIds.get(item.claimKey)!,
    facetKeys: item.facetKeys,
    relation: item.relation,
    sourceRef: item.sourceRef,
    exactQuote: item.exactQuote,
    sourceLocation: item.sourceLocation,
    sourceAuthority: item.sourceAuthority,
    independenceGroup: item.independenceGroup,
    attestationGroup: item.attestationGroup,
  }));

  const claims: InvestigationResult["claims"] = sortedClaims.map((claim) => {
    const claimEvidence = preparedEvidence.filter((item) => item.claimKey === claim.key);
    const facets = claim.facets.map((facet) => {
      const matching = claimEvidence.filter((item) => item.facetKeys.includes(facet.key));
      const expected = expectedFacetStatus(matching.map((item) => item.relation));
      const statusEvidence = expected === "SUPPORTED"
        ? matching.filter((item) => item.relation === "SUPPORTS")
        : expected === "CONTRADICTED"
          ? matching.filter((item) => item.relation === "CONTRADICTS")
          : [];
      return { ...facet, status: expected, strength: statusEvidence.length ? evidenceStrength(statusEvidence) : null, evidenceIds: matching.map((item) => evidenceIds.get(item.key)!) };
    });
    return {
      id: claimIds.get(claim.key)!,
      category: claim.category,
      statement: claim.statement,
      materiality: claim.materiality,
      sourceSpan: claim.sourceSpan,
      verdict: verdict(facets),
      strength: materialFloorStrength(facets),
      explanation: claim.explanation,
      facets,
    };
  });

  const assertEvidenceScope = (claimKeyValue: string, facetKeys: string[], evidenceKeys: string[]): void => {
    const claim = claimByKey.get(claimKeyValue);
    if (!claim) throw new Error(`Unknown summary claim ${claimKeyValue}.`);
    const declared = new Set(claim.facets.map((facet) => facet.key));
    for (const value of facetKeys) if (!declared.has(value)) throw new Error(`Summary references unknown facet ${value} on claim ${claimKeyValue}.`);
    for (const evidenceKey of evidenceKeys) {
      const item = evidenceByKey.get(evidenceKey);
      if (!item) throw new Error(`Unknown summary evidence ${evidenceKey}.`);
      if (item.claimKey !== claimKeyValue) throw new Error(`Summary evidence ${evidenceKey} does not belong to claim ${claimKeyValue}.`);
      if (!item.facetKeys.some((value) => facetKeys.includes(value))) throw new Error(`Summary evidence ${evidenceKey} does not belong to a declared facet on claim ${claimKeyValue}.`);
    }
  };
  const strongestEvidenceByClaim = draft.summary.strongestEvidenceByClaim.filter((item) => item.evidenceKeys.length > 0);
  for (const item of strongestEvidenceByClaim) assertEvidenceScope(item.claimKey, item.facetKeys, item.evidenceKeys);
  for (const item of draft.summary.materialInconsistencies) assertEvidenceScope(item.claimKey, claimByKey.get(item.claimKey)?.facets.map((facet) => facet.key) ?? [], item.evidenceKeys);

  const assertEvidenceWithinClaims = (values: string[], allowedClaimKeys: string[], label: string): void => {
    const allowed = new Set(allowedClaimKeys);
    for (const value of values) {
      const item = evidenceByKey.get(value);
      if (!item) throw new Error(`Unknown ${label} evidence ${value}.`);
      if (!allowed.has(item.claimKey)) throw new Error(`${label} evidence ${value} crosses its declared claim boundary.`);
    }
  };
  mapKnown(draft.summary.professionalIdentity.claimKeys, claimIds, "identity claim");
  mapKnown(draft.summary.timelineClaimKeys, claimIds, "timeline claim");
  assertEvidenceWithinClaims(draft.summary.professionalIdentity.evidenceKeys, draft.summary.professionalIdentity.claimKeys, "Professional identity");
  assertEvidenceWithinClaims(draft.summary.timelineEvidenceKeys, draft.summary.timelineClaimKeys, "Professional timeline");

  const summary: InvestigationResult["summary"] = {
    professionalIdentity: {
      status: draft.summary.professionalIdentity.status,
      text: draft.summary.professionalIdentity.text,
      claimIds: mapKnown(draft.summary.professionalIdentity.claimKeys, claimIds, "identity claim"),
      evidenceIds: mapKnown(draft.summary.professionalIdentity.evidenceKeys, evidenceIds, "identity evidence"),
    },
    professionalTimelineSummary: draft.summary.professionalTimelineSummary,
    timelineClaimIds: mapKnown(draft.summary.timelineClaimKeys, claimIds, "timeline claim"),
    timelineEvidenceIds: mapKnown(draft.summary.timelineEvidenceKeys, evidenceIds, "timeline evidence"),
    strongestEvidenceByClaim: strongestEvidenceByClaim.map((item) => ({
      claimId: claimIds.get(item.claimKey)!,
      facetKeys: item.facetKeys,
      evidenceIds: mapKnown(item.evidenceKeys, evidenceIds, "strongest evidence"),
    })),
    materialInconsistencies: draft.summary.materialInconsistencies.map((item) => ({
      claimId: claimIds.get(item.claimKey)!,
      text: item.text,
      evidenceIds: mapKnown(item.evidenceKeys, evidenceIds, "inconsistency evidence"),
    })),
    limitations: draft.summary.limitations,
  };

  const timeline: InvestigationResult["timeline"] = draft.timeline.map((item) => {
    const validFrom = item.validFrom ? Date.parse(item.validFrom) : Number.NaN;
    const validTo = item.validTo ? Date.parse(item.validTo) : Number.NaN;
    if (Number.isFinite(validFrom) && Number.isFinite(validTo) && validTo < validFrom) {
      throw new Error(`Timeline ${item.label} end precedes its start.`);
    }
    mapKnown(item.claimKeys, claimIds, "timeline claim");
    assertEvidenceWithinClaims(item.evidenceKeys, item.claimKeys, "Timeline");
    const timelineEvidence = item.evidenceKeys.map((value) => evidenceByKey.get(value)!).map((item) => evidence.find((candidate) => candidate.id === evidenceIds.get(item.key))!);
    return {
      label: item.label,
      ...(item.validFrom ? { validFrom: item.validFrom } : {}),
      ...(item.validTo ? { validTo: item.validTo } : {}),
      state: timelineState(timelineEvidence),
      claimIds: mapKnown(item.claimKeys, claimIds, "timeline claim"),
      evidenceIds: mapKnown(item.evidenceKeys, evidenceIds, "timeline evidence"),
    };
  });

  const resultSources: InvestigationResult["sources"] = sources
    .sort((left, right) => Number(left.ref.slice(1)) - Number(right.ref.slice(1)))
    .map((source) => ({
      ref: source.ref,
      kind: source.kind,
      ...(source.sourceUrl ? { url: source.sourceUrl } : {}),
      ...(source.title ? { title: source.title } : {}),
      provider: source.provider,
      providerRoute: source.providerRoute,
      retrievedAt: source.retrievedAt,
      sha256: source.sha256,
      byteLength: source.byteLength,
      mimeType: source.mimeType,
      sourceAuthority: effectiveSourceAuthority({ artifact: source }),
      independenceGroup: source.independenceGroup,
      attestationGroup: effectiveAttestationGroup({ artifact: source }),
      relativePath: source.relativePath,
    }));
  const sourceAuthorityCounts: Record<string, number> = {};
  for (const item of evidence) sourceAuthorityCounts[item.sourceAuthority] = (sourceAuthorityCounts[item.sourceAuthority] ?? 0) + 1;
  const hasLimitations = summary.limitations.length > 0 || claims.some((claim) => claim.facets.some((facet) => facet.status === "UNRESOLVED"));

  return {
    schemaVersion: "1.1",
    run: { ...context.run, status: hasLimitations ? "COMPLETED_WITH_LIMITATIONS" : "COMPLETED" },
    summary,
    claims,
    evidence,
    timeline,
    sources: resultSources,
    audit: {
      status: "PASSED",
      compilerAttempts: context.compilerAttempts,
      auditorAttempts: context.auditorAttempts,
      warnings: context.warnings ?? [],
      statistics: {
        claims: claims.length,
        facets: claims.reduce((sum, claim) => sum + claim.facets.length, 0),
        evidence: evidence.length,
        sources: resultSources.length,
        rejectedCitations: context.rejectedCitations ?? 0,
        sourceAuthorityCounts: Object.fromEntries(Object.entries(sourceAuthorityCounts).sort(([left], [right]) => left.localeCompare(right))),
        providerCalls: context.providerCalls ?? 0,
        cacheHits: context.cacheHits ?? 0,
      },
    },
  };
}
