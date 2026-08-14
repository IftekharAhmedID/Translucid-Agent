import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { assertSafeInvestigationLanguage } from "../core/adjudication.ts";
import { facetEvidenceCompatible } from "../core/evidence-fit.ts";
import { assertSelfContainedFacetLabels, auditClaimFacetCoverage } from "../core/facet-coverage.ts";
import { lineIdSchema, lineSpan, type LineCatalog } from "./line-catalog.ts";
import type { BundleExcerptCandidates } from "./source-store.ts";

const facetKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const category = z.enum(["IDENTITY", "EMPLOYMENT", "PROJECT", "CONTRIBUTION", "EDUCATION", "EVENT", "PUBLICATION", "AFFILIATION", "OTHER"]);
const materiality = z.enum(["HIGH", "MEDIUM", "LOW"]);
export const facetKindSchema = z.enum(["IDENTITY", "ORGANIZATION", "ORG_UNIT", "TITLE", "INTERVAL", "LOCATION", "ACTIVITY", "RESPONSIBILITY", "CONTRIBUTION", "OUTPUT", "EDUCATION", "AFFILIATION", "OTHER"]);
const normalizedTemporal = z.string().regex(/^(?:\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?|PRESENT)$/u);

const claimFacetSchema = z.object({
  key: facetKey,
  kind: facetKindSchema,
  label: z.string().min(1).max(500),
  sourceFragment: z.string().min(1).max(500),
  materiality,
  lineIds: z.array(lineIdSchema).min(1).max(100),
  from: normalizedTemporal.optional(),
  to: normalizedTemporal.optional(),
}).strict();

const claimCandidateSchema = z.object({
  localKey: z.string().min(1).max(200),
  category,
  statement: z.string().min(1).max(8_000),
  materiality,
  facets: z.array(claimFacetSchema).min(1).max(12),
}).strict();

const exclusionSchema = z.object({
  lineIds: z.array(lineIdSchema).min(1).max(100),
  reason: z.enum(["CONTACT_DETAIL", "SECTION_HEADING", "BARE_SKILL", "SUBJECTIVE_DESCRIPTION", "DUPLICATE", "NON_ASSERTIVE"]),
}).strict();

export const claimBatchSchema = z.object({
  claims: z.array(claimCandidateSchema).max(5),
  exclusions: z.array(exclusionSchema).max(100),
  deferredLineIds: z.array(lineIdSchema).max(100),
}).strict();

export const validatedClaimSchema = claimCandidateSchema.extend({
  claimKey: z.string().regex(/^C0*[1-9]\d*$/),
  lineIds: z.array(lineIdSchema).min(1).max(100),
  sourceSpan: z.object({ page: z.number().int().positive().optional(), text: z.string().min(1) }).strict(),
}).strict();

const evidenceCandidateJudgmentSchema = z.object({
  excerptRef: z.string().regex(/^X[a-f0-9]{64}$/),
  relation: z.enum(["SUPPORTS", "CONTRADICTS", "IRRELEVANT"]),
  reason: z.string().min(1).max(2_000),
}).strict();

export const evidenceJudgmentSchema = z.object({
  claimId: z.string().regex(/^C0*[1-9]\d*$/),
  candidateSetHash: z.string().regex(/^[a-f0-9]{64}$/),
  facets: z.array(z.object({ facetKey, candidates: z.array(evidenceCandidateJudgmentSchema).max(8) }).strict()).max(12),
}).strict();

export const bundleEvidenceJudgmentSchema = z.object({
  bundleId: z.string().regex(/^B0*[1-9]\d*$/),
  candidateSetHash: z.string().regex(/^[a-f0-9]{64}$/),
  dispositions: z.array(z.object({
    claimKey: z.string().regex(/^C0*[1-9]\d*$/),
    facetKey,
    excerptRef: z.string().regex(/^X[a-f0-9]{64}$/),
    relation: z.enum(["SUPPORTS", "CONTRADICTS", "CONTEXT", "IRRELEVANT"]),
    reason: z.string().min(1).max(2_000),
  }).strict()).max(360),
}).strict();

export const v5AuditSchema = z.object({
  status: z.enum(["PASSED", "REPAIR_REQUIRED"]),
  defects: z.array(z.object({
    severity: z.enum(["MATERIAL", "WARNING"]),
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(4_000),
    stage: z.enum(["CLAIM", "EVIDENCE", "SUMMARY", "AUDIT"]).default("AUDIT"),
    bundleId: z.string().regex(/^B0*[1-9]\d*$/).optional(),
    claimKeys: z.array(z.string().min(1)).max(5).default([]),
    evidenceKeys: z.array(z.string().min(1)).max(10).default([]),
    repairable: z.boolean().default(false),
  }).strict()).max(100),
}).strict();

export type ClaimBatch = z.infer<typeof claimBatchSchema>;
export type FacetKind = z.infer<typeof facetKindSchema>;
export type EvidenceJudgment = z.infer<typeof evidenceJudgmentSchema>;
export type BundleEvidenceJudgment = z.infer<typeof bundleEvidenceJudgmentSchema>;
export type V5Audit = z.infer<typeof v5AuditSchema>;
export type ExcerptRecord = { ref: string; sourceRef: string; path: string; offsetStart: number; offsetEnd: number; text: string };
export type ValidatedClaim = z.infer<typeof validatedClaimSchema>;
export type ValidatedExclusion = ClaimBatch["exclusions"][number];
export type ValidatedClaimBatch = { claims: ValidatedClaim[]; exclusions: ValidatedExclusion[]; deferredLineIds: string[] };
export type ValidatedClaimRecords = ValidatedClaimBatch & { unresolvedLineIds: string[]; defects: string[] };
export type FinalizationStage = "claims" | "evidence" | "summary" | "audit";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const checkpointPathSchema = z.string().regex(/^(?:claims\/C0*[1-9]\d*\.json|bundles\/(?:plan\.json|B0*[1-9]\d*\.(?:packet|judgment)\.json)|line-catalog\.json|coverage\.json|official-domain-registry\.json|source-authority-snapshot\.json|implementation\.json|summary\.json|audit\.json)$/);
const stageManifestEntrySchema = z.object({
  fingerprint: sha256Schema,
  configuration: z.record(z.string(), z.unknown()),
}).strict();

export const v5StageManifestSchema = z.object({
  schemaVersion: z.literal(4),
  implementation: z.literal("incremental-finalizer-v5.1"),
  stages: z.object({
    claims: stageManifestEntrySchema.optional(),
    evidence: stageManifestEntrySchema.optional(),
    summary: stageManifestEntrySchema.optional(),
    audit: stageManifestEntrySchema.optional(),
  }).strict(),
  files: z.record(checkpointPathSchema, sha256Schema),
}).strict();

export type V5StageManifest = z.infer<typeof v5StageManifestSchema>;

export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Concurrency limit must be a positive integer.");
  const results = new Array<R>(items.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

const anchorKinds = new Set<FacetKind>(["ORGANIZATION", "ORG_UNIT", "ACTIVITY", "CONTRIBUTION", "OUTPUT", "EDUCATION", "AFFILIATION"]);
const genericAnchorTokens = new Set(["company", "corporation", "education", "event", "group", "organization", "project", "publication", "team", "university"]);

function normalizedAnchor(value: string): string {
  return value.toLocaleLowerCase("en-US").normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function claimAnchors(claim: ValidatedClaim): string[] {
  return [...new Set(claim.facets
    .filter(({ kind }) => anchorKinds.has(kind))
    .flatMap(({ sourceFragment }) => {
      const phrase = normalizedAnchor(sourceFragment);
      const tokens = phrase.split(" ").filter((token) => token.length >= 3 && !genericAnchorTokens.has(token));
      return [phrase, ...tokens].filter((token) => token.length >= 3 && !genericAnchorTokens.has(token));
    }))].sort();
}

export const claimBundlePlanSchema = z.object({
  schemaVersion: z.literal(1),
  plannerVersion: z.literal("claim-bundles-v1"),
  inputSha256: sha256Schema,
  bundles: z.array(z.object({
    bundleId: z.string().regex(/^B0*[1-9]\d*$/),
    claimKeys: z.array(z.string().regex(/^C0*[1-9]\d*$/)).min(1).max(5),
    facetKeys: z.array(facetKey).min(1).max(60),
    sourceSpans: z.array(z.object({ page: z.number().int().positive().optional(), text: z.string().min(1) }).strict()).min(1).max(5),
    anchorTokens: z.array(z.string().min(1)).max(100),
  }).strict()).min(1),
}).strict();

export type ClaimBundlePlan = z.infer<typeof claimBundlePlanSchema>;

export function buildClaimBundles(claims: readonly ValidatedClaim[], exclusions: readonly ValidatedExclusion[], catalog: LineCatalog, inputSha256: string): ClaimBundlePlan {
  const positions = new Map(catalog.lines.map((line, index) => [line.id, index]));
  const headings = new Set(exclusions.filter(({ reason }) => reason === "SECTION_HEADING").flatMap(({ lineIds }) => lineIds));
  const ordered = [...claims].sort((left, right) => Math.min(...left.lineIds.map((id) => positions.get(id) ?? Number.MAX_SAFE_INTEGER)) - Math.min(...right.lineIds.map((id) => positions.get(id) ?? Number.MAX_SAFE_INTEGER)));
  const sections: ValidatedClaim[][] = [];
  for (const claim of ordered) {
    const current = sections.at(-1);
    const previous = current?.at(-1);
    const previousEnd = previous ? Math.max(...previous.lineIds.map((id) => positions.get(id) ?? -1)) : -1;
    const currentStart = Math.min(...claim.lineIds.map((id) => positions.get(id) ?? Number.MAX_SAFE_INTEGER));
    const pageChanged = previous?.sourceSpan.page !== claim.sourceSpan.page;
    const headingBetween = catalog.lines.slice(previousEnd + 1, currentStart).some(({ id }) => headings.has(id));
    if (!current || pageChanged || headingBetween) sections.push([claim]);
    else current.push(claim);
  }
  const grouped: ValidatedClaim[][] = [];
  for (const section of sections) {
    let current: ValidatedClaim[] = [];
    let anchors = new Set<string>();
    for (const claim of section) {
      const nextAnchors = claimAnchors(claim);
      const sharesAnchor = nextAnchors.some((anchor) => anchors.has(anchor));
      if (current.length >= 5 || (current.length >= 3 && !sharesAnchor)) {
        grouped.push(current);
        current = [];
        anchors = new Set<string>();
      }
      current.push(claim);
      nextAnchors.forEach((anchor) => anchors.add(anchor));
    }
    if (current.length) grouped.push(current);
  }
  return claimBundlePlanSchema.parse({
    schemaVersion: 1,
    plannerVersion: "claim-bundles-v1",
    inputSha256,
    bundles: grouped.map((bundle, index) => ({
      bundleId: `B${String(index + 1).padStart(3, "0")}`,
      claimKeys: bundle.map(({ claimKey }) => claimKey),
      facetKeys: bundle.flatMap(({ facets }) => facets.map(({ key }) => key)),
      sourceSpans: bundle.map(({ sourceSpan }) => sourceSpan),
      anchorTokens: [...new Set(bundle.flatMap(claimAnchors))].sort(),
    })),
  });
}

export function invalidatedFinalizationStages(stored: Partial<Record<FinalizationStage, string>>, current: Partial<Record<FinalizationStage, string>>): FinalizationStage[] {
  const order: FinalizationStage[] = ["claims", "evidence", "summary", "audit"];
  const first = order.findIndex((stage) => current[stage] !== undefined && stored[stage] !== current[stage]);
  return first < 0 ? [] : order.slice(first);
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}.`);
}

function orderedIds(catalog: LineCatalog, values: Iterable<string>): string[] {
  const wanted = new Set(values);
  return catalog.lines.filter(({ id }) => wanted.has(id)).map(({ id }) => id);
}

function likelyFactualAssertion(text: string): boolean {
  return /\b(?:19\d{2}|20\d{2}|worked|works|engineer|developer|founded|built|created|led|managed|published|degree|university|company|employer|employment|experience|contributed|maintained|served| at )\b/iu.test(` ${text} `);
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function contactDetail(text: string): boolean {
  return /(?:\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b|https?:\/\/|\b(?:linkedin|github)\.com\/|\+?\d[\d().\s-]{7,}\d)/iu.test(text);
}

function sectionHeading(text: string): boolean {
  const trimmed = text.trim();
  const hasDottedLeader = /(?:\s*\.){3,}\s*$/u.test(trimmed);
  const value = trimmed.replace(/(?:\s*\.){3,}\s*$/u, "").replace(/:$/u, "").trim();
  if (hasDottedLeader && value.split(/\s+/u).length <= 6 && !/\d/u.test(value) && !/\b(?:worked|works|built|created|led|managed|published|contributed|maintained|served)\b/iu.test(value)) return true;
  return /^(?:profile|professional summary|summary|experience|career experience|professional experience|employment|employment history|work experience|work history|career history|education|skills|technical skills|languages|projects|publications|certifications|awards|affiliations|volunteering|contact)$/iu.test(value)
    || (value.length >= 2 && value === value.toLocaleUpperCase("en-US") && !/\d/u.test(value) && !likelyFactualAssertion(value));
}

type ClaimFacet = ClaimBatch["claims"][number]["facets"][number];
type CatalogCoordinate = { index: number; start: number; end: number; line: LineCatalog["lines"][number] };
type FacetOccurrence = { start: number; end: number; lineIds: string[] };
type FacetChoice = { facet: ClaimFacet; order: number; occurrences: FacetOccurrence[] };

function catalogCoordinates(catalog: LineCatalog): { text: string; byId: Map<string, CatalogCoordinate> } {
  let cursor = 0;
  const byId = new Map<string, CatalogCoordinate>();
  for (const [index, line] of catalog.lines.entries()) {
    const start = cursor;
    const end = start + line.text.length;
    byId.set(line.id, { index, start, end, line });
    cursor = end + 1;
  }
  return { text: catalog.lines.map(({ text }) => text).join("\n"), byId };
}

function exactFacetOccurrences(facet: ClaimFacet, catalog: LineCatalog, coordinates: ReturnType<typeof catalogCoordinates>): FacetOccurrence[] {
  if (new Set(facet.lineIds).size !== facet.lineIds.length) throw new Error(`Facet ${facet.key} cannot repeat a frozen line ID.`);
  const lineIds = orderedIds(catalog, facet.lineIds);
  if (lineIds.length !== facet.lineIds.length) throw new Error(`Facet ${facet.key} references an unknown frozen line.`);
  const selected = lineIds.map((lineId) => coordinates.byId.get(lineId)!);
  if (selected.some(({ line }) => line.layout !== "SEMANTIC")) throw new Error(`Facet ${facet.key} may only cover semantic frozen lines.`);
  if (selected.some(({ index }, position) => position > 0 && index !== selected[position - 1]!.index + 1)) throw new Error(`Facet ${facet.key} must cover adjacent frozen lines.`);
  if (new Set(selected.map(({ line }) => line.origin)).size !== 1) throw new Error(`Facet ${facet.key} must remain within one frozen input origin.`);
  if (selected[0]!.line.origin === "PDF" && new Set(selected.map(({ line }) => line.page)).size !== 1) throw new Error(`Facet ${facet.key} must remain on the same frozen page.`);
  const spanStart = selected[0]!.start;
  const spanEnd = selected.at(-1)!.end;
  const span = coordinates.text.slice(spanStart, spanEnd);
  const occurrences: FacetOccurrence[] = [];
  for (let relativeStart = span.indexOf(facet.sourceFragment); relativeStart >= 0; relativeStart = span.indexOf(facet.sourceFragment, relativeStart + 1)) {
    const start = spanStart + relativeStart;
    const end = start + facet.sourceFragment.length;
    const intersected = selected.filter((line) => start < line.end && line.start < end).map(({ line }) => line.id);
    if (intersected.length === lineIds.length && intersected.every((lineId, index) => lineId === lineIds[index])) occurrences.push({ start, end, lineIds });
  }
  if (!occurrences.length) throw new Error(`Facet ${facet.key} must retain one exact submission fragment across every declared line.`);
  return occurrences;
}

function assignFacetOccurrences(choices: readonly FacetChoice[]): Map<ClaimFacet, FacetOccurrence> | undefined {
  const sorted = [...choices].sort((left, right) => left.occurrences.length - right.occurrences.length || right.facet.sourceFragment.length - left.facet.sourceFragment.length || left.order - right.order);
  const assigned: Array<{ facet: ClaimFacet; occurrence: FacetOccurrence }> = [];
  const visit = (index: number): boolean => {
    const choice = sorted[index];
    if (!choice) return true;
    for (const occurrence of choice.occurrences) {
      const conflicts = assigned.some((other) => occurrence.start < other.occurrence.end
        && other.occurrence.start < occurrence.end);
      if (conflicts) continue;
      assigned.push({ facet: choice.facet, occurrence });
      if (visit(index + 1)) return true;
      assigned.pop();
    }
    return false;
  };
  return visit(0) ? new Map(assigned.map(({ facet, occurrence }) => [facet, occurrence])) : undefined;
}

function validateAtomicFacets(claimKey: string, facets: ClaimBatch["claims"][number]["facets"], catalog: LineCatalog, coordinates: ReturnType<typeof catalogCoordinates>): FacetChoice[] {
  const choices = facets.map((facet, order) => {
    if (facet.kind !== "INTERVAL" && (facet.from !== undefined || facet.to !== undefined)) throw new Error(`Only INTERVAL facet ${facet.key} may declare normalized dates.`);
    if (/[;；|]|\s(?:→|⇒|\/)\s/u.test(facet.sourceFragment) || /\b(?:and then|as well as)\b/iu.test(facet.label)) throw new Error(`Facet ${facet.key} on claim ${claimKey} must contain one atomic predicate.`);
    return { facet, order, occurrences: exactFacetOccurrences(facet, catalog, coordinates) };
  });
  if (!assignFacetOccurrences(choices)) throw new Error(`Overlapping source fragments on ${claimKey} reuse one submission occurrence for multiple material facts.`);
  return choices;
}

function uncoveredLineText(coordinate: CatalogCoordinate, occurrences: readonly FacetOccurrence[]): string {
  const covered = new Uint8Array(coordinate.line.text.length);
  for (const occurrence of occurrences) {
    const start = Math.max(coordinate.start, occurrence.start) - coordinate.start;
    const end = Math.min(coordinate.end, occurrence.end) - coordinate.start;
    for (let index = Math.max(0, start); index < Math.max(0, end); index += 1) covered[index] = 1;
  }
  let result = "";
  for (let index = 0; index < coordinate.line.text.length;) {
    const codePoint = coordinate.line.text.codePointAt(index)!;
    const character = String.fromCodePoint(codePoint);
    const characterEnd = index + character.length;
    const fullyCovered = covered.subarray(index, characterEnd).every((value) => value === 1);
    result += fullyCovered || !/[\p{L}\p{N}]/u.test(character) ? " " : character;
    index = characterEnd;
  }
  return result.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function validateClaimBatchRecords(value: unknown, catalog: LineCatalog, assignedLineIds: readonly string[], claimKeyPrefix = "C", claimKeyStart = 0): ValidatedClaimRecords {
  const assigned = orderedIds(catalog, assignedLineIds);
  if (assigned.length !== new Set(assignedLineIds).size) throw new Error("Assigned line IDs contain duplicates or unknown lines.");
  if (!assigned.length) throw new Error("A claim batch requires assigned lines.");
  if (!value || typeof value !== "object") throw new Error("Claim batch must be an object.");
  const raw = value as { claims?: unknown; exclusions?: unknown; deferredLineIds?: unknown };
  const defects: string[] = [];
  const coordinates = catalogCoordinates(catalog);
  const parsedClaims = (Array.isArray(raw.claims) ? raw.claims : []).flatMap((candidate, index) => {
    const result = claimCandidateSchema.safeParse(candidate);
    if (result.success) {
      try {
        unique(result.data.facets.map(({ key }) => key), `facet key on ${result.data.localKey}`);
        assertSelfContainedFacetLabels(result.data.localKey, result.data.facets);
        const choices = validateAtomicFacets(result.data.localKey, result.data.facets, catalog, coordinates);
        const coverage = auditClaimFacetCoverage(result.data.statement, result.data.facets);
        if (!coverage.complete) throw new Error(`Material claim clause has no facet: ${coverage.uncovered.map(({ clause }) => clause).join(" | ")}`);
        assertSafeInvestigationLanguage(result.data);
        return [{ index, value: result.data, choices }];
      } catch (error) {
        defects.push(`${result.data.localKey}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    }
    const key = candidate && typeof candidate === "object" && typeof (candidate as { localKey?: unknown }).localKey === "string" ? (candidate as { localKey: string }).localKey : `claim ${index + 1}`;
    defects.push(`${key}: ${z.prettifyError(result.error)}`);
    return [];
  });
  const parsedExclusions = (Array.isArray(raw.exclusions) ? raw.exclusions : []).flatMap((candidate, index) => {
    const result = exclusionSchema.safeParse(candidate);
    if (result.success) {
      const lines = result.data.lineIds.flatMap((lineId) => catalog.lines.find(({ id }) => id === lineId) ?? []);
      const normalized = (text: string) => text.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
      if (result.data.reason === "DUPLICATE" && lines.some((line) => catalog.lines.filter((candidateLine) => normalized(candidateLine.text) === normalized(line.text)).length < 2)) {
        defects.push(`exclusion ${index + 1}: line is not duplicated in the frozen input.`);
        return [];
      }
      if (new Set(["BARE_SKILL", "SUBJECTIVE_DESCRIPTION", "NON_ASSERTIVE"]).has(result.data.reason) && lines.some(({ text }) => likelyFactualAssertion(text))) {
        defects.push(`exclusion ${index + 1}: likely factual assertion must remain a claim.`);
        return [];
      }
      if (result.data.reason === "CONTACT_DETAIL" && lines.some(({ text }) => !contactDetail(text))) {
        defects.push(`exclusion ${index + 1}: line is not a contact detail.`);
        return [];
      }
      if (result.data.reason === "SECTION_HEADING" && lines.some(({ text }) => !sectionHeading(text))) {
        defects.push(`exclusion ${index + 1}: line is not a recognized section heading.`);
        return [];
      }
      return [{ index, value: result.data }];
    }
    defects.push(`exclusion ${index + 1}: ${z.prettifyError(result.error)}`);
    return [];
  });
  const deferredResult = z.array(lineIdSchema).max(100).safeParse(raw.deferredLineIds ?? []);
  if (!deferredResult.success) defects.push(`deferred lines: ${z.prettifyError(deferredResult.error)}`);
  const deferred = deferredResult.success ? orderedIds(catalog, deferredResult.data) : [];
  const owners = new Map<string, string[]>();
  const addOwner = (lineId: string, owner: string) => owners.set(lineId, [...(owners.get(lineId) ?? []), owner]);
  for (const { index, value: claim } of parsedClaims) for (const lineId of new Set(claim.facets.flatMap(({ lineIds }) => lineIds))) addOwner(lineId, `claim:${index}`);
  for (const { index, value: exclusion } of parsedExclusions) for (const lineId of new Set(exclusion.lineIds)) addOwner(lineId, `exclusion:${index}`);
  for (const lineId of deferred) addOwner(lineId, "deferred");
  const assignedSet = new Set(assigned);
  const invalidOwners = new Set<string>();
  for (const [lineId, lineOwners] of owners) {
    const claimOwners = lineOwners.filter((owner) => owner.startsWith("claim:"));
    const otherOwners = lineOwners.filter((owner) => !owner.startsWith("claim:"));
    const multipleDispositions = otherOwners.length > 1 || (claimOwners.length > 0 && otherOwners.length > 0);
    if (!assignedSet.has(lineId) || multipleDispositions) for (const owner of lineOwners) invalidOwners.add(owner);
    if (!assignedSet.has(lineId)) defects.push(`Line ${lineId} is outside the assigned claim window.`);
    else if (multipleDispositions) defects.push(`Line ${lineId} has more than one disposition.`);
  }
  const assignedOccurrences = new Map<ClaimFacet, FacetOccurrence>();
  const remainingClaims = parsedClaims.filter(({ index }) => !invalidOwners.has(`claim:${index}`));
  const pending = new Set(remainingClaims.map(({ index }) => index));
  while (pending.size) {
    const first = pending.values().next().value as number;
    const componentIndexes = new Set([first]);
    pending.delete(first);
    let expanded = true;
    while (expanded) {
      expanded = false;
      const componentLines = new Set(remainingClaims.filter(({ index }) => componentIndexes.has(index)).flatMap(({ value: claim }) => claim.facets.flatMap(({ lineIds }) => lineIds)));
      for (const candidateIndex of [...pending]) {
        const candidate = remainingClaims.find(({ index }) => index === candidateIndex)!;
        if (!candidate.value.facets.some(({ lineIds }) => lineIds.some((lineId) => componentLines.has(lineId)))) continue;
        componentIndexes.add(candidateIndex);
        pending.delete(candidateIndex);
        expanded = true;
      }
    }
    const component = remainingClaims.filter(({ index }) => componentIndexes.has(index));
    const occurrenceMap = assignFacetOccurrences(component.flatMap(({ choices }) => choices));
    const componentOwners = component.map(({ index }) => `claim:${index}`);
    if (!occurrenceMap) {
      componentOwners.forEach((owner) => invalidOwners.add(owner));
      defects.push(`Claims ${component.map(({ value: claim }) => claim.localKey).join(", ")} have conflicting exact source ranges.`);
      continue;
    }
    const componentLineIds = orderedIds(catalog, component.flatMap(({ value: claim }) => claim.facets.flatMap(({ lineIds }) => lineIds)));
    const componentOccurrences = [...occurrenceMap.values()];
    const uncovered = componentLineIds.flatMap((lineId) => {
      const coordinate = coordinates.byId.get(lineId)!;
      const text = uncoveredLineText(coordinate, componentOccurrences);
      return text ? [{ lineId, text }] : [];
    });
    if (uncovered.length) {
      componentOwners.forEach((owner) => invalidOwners.add(owner));
      defects.push(`Claims ${component.map(({ value: claim }) => claim.localKey).join(", ")} leave uncovered material text: ${uncovered.map(({ lineId, text }) => `${lineId}=${text}`).join(" | ")}`);
      continue;
    }
    for (const [facet, occurrence] of occurrenceMap) assignedOccurrences.set(facet, occurrence);
  }
  const assignedPosition = new Map(assigned.map((lineId, index) => [lineId, index]));
  const earliestPosition = (lineIds: readonly string[]) => Math.min(...lineIds.map((lineId) => assignedPosition.get(lineId) ?? Number.MAX_SAFE_INTEGER));
  const acceptedClaims = parsedClaims
    .filter(({ index }) => !invalidOwners.has(`claim:${index}`))
    .sort((left, right) => Math.min(...left.value.facets.map((facet) => assignedOccurrences.get(facet)?.start ?? Number.MAX_SAFE_INTEGER)) - Math.min(...right.value.facets.map((facet) => assignedOccurrences.get(facet)?.start ?? Number.MAX_SAFE_INTEGER)) || lexicalCompare(left.value.localKey, right.value.localKey));
  const claims = acceptedClaims.map(({ value: claim }, index) => {
    const orderedFacets = claim.facets
      .map((facet) => ({ ...facet, lineIds: orderedIds(catalog, facet.lineIds) }))
      .sort((left, right) => {
        const originalLeft = claim.facets.find((facet) => facet.key === left.key)!;
        const originalRight = claim.facets.find((facet) => facet.key === right.key)!;
        const positionOrder = (assignedOccurrences.get(originalLeft)?.start ?? Number.MAX_SAFE_INTEGER) - (assignedOccurrences.get(originalRight)?.start ?? Number.MAX_SAFE_INTEGER);
        return positionOrder || lexicalCompare(left.kind, right.kind) || lexicalCompare(left.sourceFragment, right.sourceFragment);
      });
    const kindCounts = new Map<string, number>();
    const facets = orderedFacets.map((facet) => {
      const base = facet.kind.toLocaleLowerCase("en-US");
      const occurrence = (kindCounts.get(base) ?? 0) + 1;
      kindCounts.set(base, occurrence);
      return { ...facet, key: occurrence === 1 ? base : `${base}_${occurrence}` };
    });
    const lineIds = orderedIds(catalog, facets.flatMap(({ lineIds }) => lineIds));
    return { ...claim, facets, claimKey: `${claimKeyPrefix}${String(claimKeyStart + index + 1).padStart(3, "0")}`, lineIds, sourceSpan: lineSpan(catalog, lineIds) };
  });
  const exclusions = parsedExclusions
    .filter(({ index }) => !invalidOwners.has(`exclusion:${index}`))
    .sort((left, right) => earliestPosition(left.value.lineIds) - earliestPosition(right.value.lineIds) || lexicalCompare(left.value.reason, right.value.reason))
    .map(({ value }) => ({ ...value, lineIds: orderedIds(catalog, value.lineIds) }));
  const earliest = assigned[0];
  const deferredEarliest = earliest !== undefined && deferred.includes(earliest) && !invalidOwners.has("deferred");
  if (deferredEarliest) defects.push(`Claim batch deferred the earliest unresolved line ${earliest}.`);
  const acceptedDeferred = deferred.filter((lineId) => !invalidOwners.has("deferred") && assignedSet.has(lineId) && lineId !== earliest);
  const resolved = new Set([...claims.flatMap(({ lineIds }) => lineIds), ...exclusions.flatMap(({ lineIds }) => lineIds), ...acceptedDeferred]);
  return { claims, exclusions, deferredLineIds: acceptedDeferred, unresolvedLineIds: assigned.filter((lineId) => !resolved.has(lineId)), defects };
}

export function validateEvidenceJudgment(value: unknown, claim: { claimKey: string; facets: ReadonlyArray<{ key: string; label?: string }> }, candidatesByFacet: ReadonlyMap<string, readonly ExcerptRecord[]>, candidateSetHash: string): EvidenceJudgment {
  const judgment = evidenceJudgmentSchema.parse(value);
  if (judgment.claimId !== claim.claimKey) throw new Error(`Evidence judgment references unknown claim ${judgment.claimId}.`);
  if (judgment.candidateSetHash !== candidateSetHash) throw new Error(`Evidence judgment candidate-set hash does not match claim ${claim.claimKey}.`);
  unique(judgment.facets.map(({ facetKey: key }) => key), `evidence facet on ${judgment.claimId}`);
  if (judgment.facets.length !== claim.facets.length || claim.facets.some(({ key }) => !judgment.facets.some(({ facetKey }) => facetKey === key))) throw new Error(`Evidence judgment facets do not exactly match claim ${claim.claimKey}.`);
  for (const facet of judgment.facets) {
    const assigned = candidatesByFacet.get(facet.facetKey) ?? [];
    const expected = new Set(assigned.map(({ ref }) => ref));
    unique(facet.candidates.map(({ excerptRef }) => excerptRef), `candidate on ${claim.claimKey}/${facet.facetKey}`);
    const actual = new Set(facet.candidates.map(({ excerptRef }) => excerptRef));
    const unknown = facet.candidates.find(({ excerptRef }) => !expected.has(excerptRef));
    const expectedRefs = [...expected];
    if (unknown) throw new Error(`Evidence judgment references unknown excerpt ${unknown.excerptRef}. Expected exact excerpt refs: ${expectedRefs.join(", ")}.`);
    const missing = expectedRefs.filter((ref) => !actual.has(ref));
    if (actual.size !== expected.size || missing.length) throw new Error(`Evidence judgment must exactly account for assigned candidates on ${claim.claimKey}/${facet.facetKey}; missing ${missing.join(", ") || "none"}.`);
    const label = claim.facets.find(({ key }) => key === facet.facetKey)?.label;
    const incompatible = label && facet.candidates.find(({ excerptRef, relation }) => relation !== "IRRELEVANT" && !facetEvidenceCompatible(assigned.find(({ ref }) => ref === excerptRef)!.text, label));
    if (incompatible) throw new Error(`Evidence judgment marks semantically incompatible excerpt ${incompatible.excerptRef} as ${incompatible.relation} on ${claim.claimKey}/${facet.facetKey}.`);
  }
  const facetsByKey = new Map(judgment.facets.map((facet) => [facet.facetKey, facet]));
  return {
    ...judgment,
    facets: claim.facets.map(({ key }) => {
      const facet = facetsByKey.get(key)!;
      const candidatesByRef = new Map(facet.candidates.map((candidate) => [candidate.excerptRef, candidate]));
      return {
        facetKey: key,
        candidates: (candidatesByFacet.get(key) ?? []).map(({ ref }) => candidatesByRef.get(ref)!),
      };
    }),
  };
}

export function validateBundleEvidenceJudgment(
  value: unknown,
  bundleId: string,
  claims: ReadonlyArray<{ claimKey: string; facets: ReadonlyArray<{ key: string; label: string; kind?: FacetKind }> }>,
  candidateSet: BundleExcerptCandidates,
  candidateSetHash = candidateSet.fingerprint,
  identityAnchors: readonly string[] = [],
): BundleEvidenceJudgment {
  const judgment = bundleEvidenceJudgmentSchema.parse(value);
  if (judgment.bundleId !== bundleId || candidateSet.bundleId !== bundleId) throw new Error(`Evidence judgment references an unknown bundle ${judgment.bundleId}.`);
  if (judgment.candidateSetHash !== candidateSetHash) throw new Error(`Evidence judgment candidate-set hash does not match bundle ${bundleId}.`);
  const claimByKey = new Map(claims.map((claim) => [claim.claimKey, claim]));
  const expected = candidateSet.facets.flatMap((facet) => {
    const claim = claimByKey.get(facet.claimKey);
    const declaredFacet = claim?.facets.find(({ key }) => key === facet.facetKey);
    if (!declaredFacet) throw new Error(`Candidate set references unknown facet ${facet.claimKey}/${facet.facetKey}.`);
    return facet.candidates.map((candidate) => ({ claimKey: facet.claimKey, facetKey: facet.facetKey, candidate, declaredFacet }));
  });
  const key = (item: { claimKey: string; facetKey: string; excerptRef: string }) => `${item.claimKey}\0${item.facetKey}\0${item.excerptRef}`;
  unique(judgment.dispositions.map(key), `candidate disposition on ${bundleId}`);
  const byKey = new Map(judgment.dispositions.map((disposition) => [key(disposition), disposition]));
  const expectedKeys = new Set(expected.map(({ claimKey, facetKey, candidate }) => key({ claimKey, facetKey, excerptRef: candidate.ref })));
  const unknown = judgment.dispositions.find((disposition) => !expectedKeys.has(key(disposition)));
  if (unknown) throw new Error(`Evidence judgment references an unknown candidate assignment on ${unknown.claimKey}/${unknown.facetKey}/${unknown.excerptRef}.`);
  const missing = expected.filter(({ claimKey, facetKey, candidate }) => !byKey.has(key({ claimKey, facetKey, excerptRef: candidate.ref })));
  if (judgment.dispositions.length !== expected.length || missing.length) throw new Error(`Evidence judgment must exactly account for assigned bundle candidates; missing ${missing.map(({ claimKey, facetKey, candidate }) => `${claimKey}/${facetKey}/${candidate.ref}`).join(", ") || "none"}.`);
  for (const item of expected) {
    const disposition = byKey.get(key({ claimKey: item.claimKey, facetKey: item.facetKey, excerptRef: item.candidate.ref }))!;
    if (!item.candidate.evidenceEligible && (disposition.relation === "SUPPORTS" || disposition.relation === "CONTRADICTS")) throw new Error(`Context or discovery candidate ${item.candidate.ref} is ineligible for ${disposition.relation}.`);
    if (disposition.relation === "SUPPORTS" || disposition.relation === "CONTRADICTS") {
      if (!facetEvidenceCompatible(item.candidate.text, item.declaredFacet.label)) throw new Error(`Evidence judgment marks semantically incompatible excerpt ${item.candidate.ref} as ${disposition.relation} on ${item.claimKey}/${item.facetKey}.`);
      if (new Set<FacetKind>(["ACTIVITY", "RESPONSIBILITY", "CONTRIBUTION"]).has(item.declaredFacet.kind as FacetKind)
        && !/\b(?:authored|built|contributed|created|developed|directed|engineered|founded|implemented|led|maintained|managed|organized|organised|presented|published|served|worked)\b/iu.test(item.candidate.text)) {
        throw new Error(`Project or organization existence cannot establish personal ${item.declaredFacet.kind?.toLowerCase()} on ${item.claimKey}/${item.facetKey}.`);
      }
      if (item.declaredFacet.kind === "INTERVAL") {
        const expectedYears = new Set(item.declaredFacet.label.match(/\b(?:19|20)\d{2}\b/gu) ?? []);
        const quoteYears = new Set(item.candidate.text.match(/\b(?:19|20)\d{2}\b/gu) ?? []);
        if (expectedYears.size > 0 && ![...expectedYears].some((year) => quoteYears.has(year))) throw new Error(`Temporal evidence does not overlap the declared interval on ${item.claimKey}/${item.facetKey}.`);
      }
      const actor = item.candidate.text.match(/\b([\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+){1,3})\s+(?:authored|built|contributed|created|developed|directed|founded|held|joined|led|maintained|managed|presented|published|served|worked)\b/u)?.[1];
      if (actor && identityAnchors.length) {
        const actorLast = normalizedAnchor(actor).split(" ").at(-1);
        const knownLastNames = new Set(identityAnchors.map((anchor) => normalizedAnchor(anchor).split(" ").at(-1)).filter(Boolean));
        if (actorLast && knownLastNames.size > 0 && !knownLastNames.has(actorLast)) throw new Error(`Evidence candidate ${item.candidate.ref} explicitly attributes the predicate to a different person.`);
      }
    }
  }
  return {
    ...judgment,
    dispositions: expected.map(({ claimKey, facetKey, candidate }) => byKey.get(key({ claimKey, facetKey, excerptRef: candidate.ref }))!),
  };
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export async function readJsonIfPresent<T>(path: string, parse: (value: unknown) => T): Promise<T | undefined> {
  try { return parse(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
