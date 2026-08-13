import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { assertSafeInvestigationLanguage } from "../core/adjudication.ts";
import { facetEvidenceCompatible } from "../core/evidence-fit.ts";
import { assertSelfContainedFacetLabels, auditClaimFacetCoverage } from "../core/facet-coverage.ts";
import { lineIdSchema, lineSpan, type LineCatalog } from "./line-catalog.ts";

const facetKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const category = z.enum(["IDENTITY", "EMPLOYMENT", "PROJECT", "CONTRIBUTION", "EDUCATION", "EVENT", "PUBLICATION", "AFFILIATION", "OTHER"]);
const materiality = z.enum(["HIGH", "MEDIUM", "LOW"]);

const claimCandidateSchema = z.object({
  localKey: z.string().min(1).max(200),
  category,
  statement: z.string().min(1).max(8_000),
  materiality,
  facets: z.array(z.object({ key: facetKey, label: z.string().min(1).max(500), materiality, lineIds: z.array(lineIdSchema).min(1).max(100) }).strict()).min(1).max(12),
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

export const v5AuditSchema = z.object({
  status: z.enum(["PASSED", "REPAIR_REQUIRED"]),
  defects: z.array(z.object({
    severity: z.enum(["MATERIAL", "WARNING"]),
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(4_000),
    stage: z.enum(["CLAIM", "EVIDENCE", "SUMMARY", "AUDIT"]).default("AUDIT"),
    claimKeys: z.array(z.string().min(1)).max(3).default([]),
    evidenceKeys: z.array(z.string().min(1)).max(10).default([]),
    repairable: z.boolean().default(false),
  }).strict()).max(100),
}).strict();

export type ClaimBatch = z.infer<typeof claimBatchSchema>;
export type EvidenceJudgment = z.infer<typeof evidenceJudgmentSchema>;
export type V5Audit = z.infer<typeof v5AuditSchema>;
export type ExcerptRecord = { ref: string; sourceRef: string; path: string; offsetStart: number; offsetEnd: number; text: string };
export type ValidatedClaim = z.infer<typeof validatedClaimSchema>;
export type ValidatedExclusion = ClaimBatch["exclusions"][number];
export type ValidatedClaimBatch = { claims: ValidatedClaim[]; exclusions: ValidatedExclusion[]; deferredLineIds: string[] };
export type ValidatedClaimRecords = ValidatedClaimBatch & { unresolvedLineIds: string[]; defects: string[] };
export type FinalizationStage = "claims" | "evidence" | "summary" | "audit";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const checkpointPathSchema = z.string().regex(/^(?:claims\/C0*[1-9]\d*\.json|evidence\/C0*[1-9]\d*\.(?:candidates|judgment)\.json|line-catalog\.json|coverage\.json|source-authority-snapshot\.json|summary\.json|audit\.json)$/);
const stageManifestEntrySchema = z.object({
  fingerprint: sha256Schema,
  configuration: z.record(z.string(), z.unknown()),
}).strict();

export const v5StageManifestSchema = z.object({
  schemaVersion: z.literal(3),
  implementation: z.literal("incremental-finalizer-v5"),
  stages: z.object({
    claims: stageManifestEntrySchema.optional(),
    evidence: stageManifestEntrySchema.optional(),
    summary: stageManifestEntrySchema.optional(),
    audit: stageManifestEntrySchema.optional(),
  }).strict(),
  files: z.record(checkpointPathSchema, sha256Schema),
}).strict();

export type V5StageManifest = z.infer<typeof v5StageManifestSchema>;

export function invalidatedFinalizationStages(stored: Partial<Record<FinalizationStage, string>>, current: Partial<Record<FinalizationStage, string>>): FinalizationStage[] {
  const order: FinalizationStage[] = ["claims", "evidence", "summary", "audit"];
  const first = order.findIndex((stage) => current[stage] !== undefined && stored[stage] !== current[stage]);
  return first < 0 ? [] : order.slice(first);
}

const adjacentWork = /\b(?:commit|pull request|patch|jit|optimization)\b/i;
const statusProofs: Array<[RegExp, RegExp]> = [
  [/\b(?:core developer|core team)\b/i, /\b(?:core developer|core team|core member)\b/i],
  [/\b(?:employed|employment|works? at|worked at|tenure)\b/i, /\b(?:employed|employment|works? at|worked at|joined|tenure)\b/i],
  [/\b(?:title|held the title)\b/i, /\b(?:title|engineer|developer|manager|director)\b/i],
  [/(?:organiz\w+.*europython|europython.*organiz\w+)/i, /(?:organiz\w+.*europython|europython.*organiz\w+)/i],
  [/(?:python guild.*(?:lead|led|member)|(?:lead|led|member).*python guild)/i, /(?:python guild.*(?:lead|led|member)|(?:lead|led|member).*python guild)/i],
];

export function v5FacetEvidenceCompatible(exactQuote: string, facetLabel: string): boolean {
  if (adjacentWork.test(exactQuote) && statusProofs.some(([claim, proof]) => claim.test(facetLabel) && !proof.test(exactQuote))) return false;
  return facetEvidenceCompatible(exactQuote, facetLabel);
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
  const value = text.trim().replace(/:$/u, "");
  return /^(?:profile|professional summary|summary|experience|employment|employment history|work experience|education|skills|technical skills|projects|publications|certifications|awards|affiliations|volunteering|contact)$/iu.test(value)
    || (value.length >= 2 && value === value.toLocaleUpperCase("en-US") && !/\d/u.test(value) && !likelyFactualAssertion(value));
}

export function validateClaimBatchRecords(value: unknown, catalog: LineCatalog, assignedLineIds: readonly string[], claimKeyPrefix = "C", claimKeyStart = 0): ValidatedClaimRecords {
  const assigned = orderedIds(catalog, assignedLineIds);
  if (assigned.length !== new Set(assignedLineIds).size) throw new Error("Assigned line IDs contain duplicates or unknown lines.");
  if (!assigned.length) throw new Error("A claim batch requires assigned lines.");
  if (!value || typeof value !== "object") throw new Error("Claim batch must be an object.");
  const raw = value as { claims?: unknown; exclusions?: unknown; deferredLineIds?: unknown };
  const defects: string[] = [];
  const parsedClaims = (Array.isArray(raw.claims) ? raw.claims : []).flatMap((candidate, index) => {
    const result = claimCandidateSchema.safeParse(candidate);
    if (result.success) {
      try {
        unique(result.data.facets.map(({ key }) => key), `facet key on ${result.data.localKey}`);
        assertSelfContainedFacetLabels(result.data.localKey, result.data.facets);
        const coverage = auditClaimFacetCoverage(result.data.statement, result.data.facets);
        if (!coverage.complete) throw new Error(`Material claim clause has no facet: ${coverage.uncovered.map(({ clause }) => clause).join(" | ")}`);
        assertSafeInvestigationLanguage(result.data);
        return [{ index, value: result.data }];
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
    if (!assignedSet.has(lineId) || lineOwners.length > 1) for (const owner of lineOwners) invalidOwners.add(owner);
    if (!assignedSet.has(lineId)) defects.push(`Line ${lineId} is outside the assigned claim window.`);
    else if (lineOwners.length > 1) defects.push(`Line ${lineId} has more than one disposition.`);
  }
  const assignedPosition = new Map(assigned.map((lineId, index) => [lineId, index]));
  const earliestPosition = (lineIds: readonly string[]) => Math.min(...lineIds.map((lineId) => assignedPosition.get(lineId) ?? Number.MAX_SAFE_INTEGER));
  const acceptedClaims = parsedClaims
    .filter(({ index }) => !invalidOwners.has(`claim:${index}`))
    .sort((left, right) => earliestPosition(left.value.facets.flatMap(({ lineIds }) => lineIds)) - earliestPosition(right.value.facets.flatMap(({ lineIds }) => lineIds)) || lexicalCompare(left.value.localKey, right.value.localKey));
  const claims = acceptedClaims.map(({ value: claim }, index) => {
    const facets = claim.facets
      .map((facet) => ({ ...facet, lineIds: orderedIds(catalog, facet.lineIds) }))
      .sort((left, right) => earliestPosition(left.lineIds) - earliestPosition(right.lineIds) || lexicalCompare(left.key, right.key));
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
    if (unknown) throw new Error(`Evidence judgment references unknown excerpt ${unknown.excerptRef}.`);
    if (actual.size !== expected.size || [...expected].some((ref) => !actual.has(ref))) throw new Error(`Evidence judgment must exactly account for assigned candidates on ${claim.claimKey}/${facet.facetKey}.`);
    const label = claim.facets.find(({ key }) => key === facet.facetKey)?.label;
    const incompatible = label && facet.candidates.find(({ excerptRef, relation }) => relation !== "IRRELEVANT" && !v5FacetEvidenceCompatible(assigned.find(({ ref }) => ref === excerptRef)!.text, label));
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
