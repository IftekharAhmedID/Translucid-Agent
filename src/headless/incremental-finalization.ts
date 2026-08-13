import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

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

const evidenceEdgeSchema = z.object({
  facetKeys: z.array(facetKey).min(1).max(12),
  relation: z.enum(["SUPPORTS", "CONTRADICTS"]),
  excerptRef: z.string().regex(/^X[a-f0-9]{64}$/),
}).strict();

const evidenceClaimSchema = z.object({
  claimId: z.string().regex(/^C0*[1-9]\d*$/),
  explanation: z.string().min(1).max(8_000),
  facetNotes: z.array(z.object({ facetKey, note: z.string().min(1).max(2_000) }).strict()).max(12),
  edges: z.array(evidenceEdgeSchema).max(100),
}).strict();

export const evidenceBatchSchema = z.object({ claims: z.array(evidenceClaimSchema).max(5) }).strict();

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

export type ClaimBatch = z.infer<typeof claimBatchSchema>;
export type EvidenceBatch = z.infer<typeof evidenceBatchSchema>;
export type EvidenceJudgment = z.infer<typeof evidenceJudgmentSchema>;
export type ExcerptRecord = { ref: string; sourceRef: string; path: string; offsetStart: number; offsetEnd: number; text: string };
export type ValidatedClaim = ClaimBatch["claims"][number] & { claimKey: string; lineIds: string[]; sourceSpan: { page?: number; text: string } };
export type ValidatedExclusion = ClaimBatch["exclusions"][number];
export type ValidatedClaimBatch = { claims: ValidatedClaim[]; exclusions: ValidatedExclusion[]; deferredLineIds: string[] };
export type ValidatedClaimRecords = ValidatedClaimBatch & { unresolvedLineIds: string[]; defects: string[] };

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}.`);
}

function orderedIds(catalog: LineCatalog, values: Iterable<string>): string[] {
  const wanted = new Set(values);
  return catalog.lines.filter(({ id }) => wanted.has(id)).map(({ id }) => id);
}

export function validateClaimBatch(value: unknown, catalog: LineCatalog, assignedLineIds: readonly string[], claimKeyPrefix = "C", claimKeyStart = 0): ValidatedClaimBatch {
  const batch = claimBatchSchema.parse(value);
  const assigned = orderedIds(catalog, assignedLineIds);
  if (assigned.length !== new Set(assignedLineIds).size) throw new Error("Assigned line IDs contain duplicates or unknown lines.");
  if (assigned.length === 0) throw new Error("A claim batch requires assigned lines.");
  const ownership = new Map<string, string>();
  const mark = (lineId: string, owner: string) => {
    if (!assigned.includes(lineId)) throw new Error(`Line ${lineId} is outside the assigned claim window.`);
    if (ownership.has(lineId)) throw new Error(`Line ${lineId} has more than one disposition.`);
    ownership.set(lineId, owner);
  };
  unique(batch.claims.map(({ localKey }) => localKey), "claim local key");
  const claims = batch.claims.map((claim, index) => {
    const claimLineIds = orderedIds(catalog, claim.facets.flatMap(({ lineIds }) => lineIds));
    if (!claimLineIds.length) throw new Error(`Claim ${claim.localKey} has no source lines.`);
    unique(claim.facets.map(({ key }) => key), `facet key on ${claim.localKey}`);
    for (const lineId of claimLineIds) mark(lineId, `claim:${index}`);
    return { ...claim, claimKey: `${claimKeyPrefix}${String(claimKeyStart + index + 1).padStart(3, "0")}`, lineIds: claimLineIds, sourceSpan: lineSpan(catalog, claimLineIds) };
  });
  const exclusions = batch.exclusions.map((exclusion, index) => {
    const lineIds = orderedIds(catalog, exclusion.lineIds);
    if (!lineIds.length) throw new Error("An exclusion has no source lines.");
    for (const lineId of lineIds) mark(lineId, `exclusion:${index}`);
    return { ...exclusion, lineIds };
  });
  const deferredLineIds = orderedIds(catalog, batch.deferredLineIds);
  for (const lineId of deferredLineIds) mark(lineId, "deferred");
  if (ownership.size !== assigned.length) {
    const missing = assigned.find((lineId) => !ownership.has(lineId));
    throw new Error(`Claim batch omitted assigned line ${missing}.`);
  }
  const earliest = assigned[0]!;
  if (!ownership.has(earliest) || ownership.get(earliest) === "deferred") throw new Error("Claim batch made no progress on the earliest unresolved line.");
  return { claims, exclusions, deferredLineIds };
}

export function validateClaimBatchRecords(value: unknown, catalog: LineCatalog, assignedLineIds: readonly string[], claimKeyPrefix = "C", claimKeyStart = 0): ValidatedClaimRecords {
  const assigned = orderedIds(catalog, assignedLineIds);
  if (assigned.length !== new Set(assignedLineIds).size) throw new Error("Assigned line IDs contain duplicates or unknown lines.");
  if (!value || typeof value !== "object") throw new Error("Claim batch must be an object.");
  const raw = value as { claims?: unknown; exclusions?: unknown; deferredLineIds?: unknown };
  const defects: string[] = [];
  const parsedClaims = (Array.isArray(raw.claims) ? raw.claims : []).flatMap((candidate, index) => {
    const result = claimCandidateSchema.safeParse(candidate);
    if (result.success) return [{ index, value: result.data }];
    const key = candidate && typeof candidate === "object" && typeof (candidate as { localKey?: unknown }).localKey === "string" ? (candidate as { localKey: string }).localKey : `claim ${index + 1}`;
    defects.push(`${key}: ${z.prettifyError(result.error)}`);
    return [];
  });
  const parsedExclusions = (Array.isArray(raw.exclusions) ? raw.exclusions : []).flatMap((candidate, index) => {
    const result = exclusionSchema.safeParse(candidate);
    if (result.success) return [{ index, value: result.data }];
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
  const acceptedClaims = parsedClaims.filter(({ index }) => !invalidOwners.has(`claim:${index}`));
  const claims = acceptedClaims.map(({ value: claim }, index) => {
    const lineIds = orderedIds(catalog, claim.facets.flatMap(({ lineIds }) => lineIds));
    return { ...claim, claimKey: `${claimKeyPrefix}${String(claimKeyStart + index + 1).padStart(3, "0")}`, lineIds, sourceSpan: lineSpan(catalog, lineIds) };
  });
  const exclusions = parsedExclusions.filter(({ index }) => !invalidOwners.has(`exclusion:${index}`)).map(({ value }) => ({ ...value, lineIds: orderedIds(catalog, value.lineIds) }));
  const acceptedDeferred = deferred.filter((lineId) => !invalidOwners.has("deferred") && assignedSet.has(lineId));
  const resolved = new Set([...claims.flatMap(({ lineIds }) => lineIds), ...exclusions.flatMap(({ lineIds }) => lineIds), ...acceptedDeferred]);
  return { claims, exclusions, deferredLineIds: acceptedDeferred, unresolvedLineIds: assigned.filter((lineId) => !resolved.has(lineId)), defects };
}

export function validateEvidenceBatch(value: unknown, claims: ReadonlyArray<{ claimKey: string; facets: ReadonlyArray<{ key: string }> }>, excerpts: ReadonlyMap<string, ExcerptRecord>): EvidenceBatch {
  const batch = evidenceBatchSchema.parse(value);
  const claimById = new Map(claims.map((claim) => [claim.claimKey, claim]));
  unique(batch.claims.map(({ claimId }) => claimId), "evidence claim");
  if (batch.claims.length !== claims.length || claims.some(({ claimKey }) => !batch.claims.some(({ claimId }) => claimId === claimKey))) throw new Error("Evidence batch does not exactly match assigned claims.");
  for (const item of batch.claims) {
    const claim = claimById.get(item.claimId);
    if (!claim) throw new Error(`Evidence references unknown claim ${item.claimId}.`);
    const declared = new Set(claim.facets.map(({ key }) => key));
    unique(item.facetNotes.map(({ facetKey: key }) => key), `facet note on ${item.claimId}`);
    if (item.facetNotes.length !== declared.size || item.facetNotes.some(({ facetKey: key }) => !declared.has(key))) throw new Error(`Evidence facet notes do not match claim ${item.claimId}.`);
    for (const edge of item.edges) {
      unique(edge.facetKeys, `edge facet on ${item.claimId}`);
      if (edge.facetKeys.some((key) => !declared.has(key))) throw new Error(`Evidence edge references an unknown facet on ${item.claimId}.`);
      if (!excerpts.has(edge.excerptRef)) throw new Error(`Evidence references unknown excerpt ${edge.excerptRef}.`);
    }
  }
  return batch;
}

export function validateEvidenceJudgment(value: unknown, claim: { claimKey: string; facets: ReadonlyArray<{ key: string }> }, candidatesByFacet: ReadonlyMap<string, readonly ExcerptRecord[]>): EvidenceJudgment {
  const judgment = evidenceJudgmentSchema.parse(value);
  if (judgment.claimId !== claim.claimKey) throw new Error(`Evidence judgment references unknown claim ${judgment.claimId}.`);
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
  }
  return judgment;
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

export function claimOutline(claim: ValidatedClaim): Record<string, unknown> {
  return { key: claim.claimKey, category: claim.category, statement: claim.statement, materiality: claim.materiality, sourceSpan: { ...claim.sourceSpan, lineIds: claim.lineIds }, facets: claim.facets.map(({ key, label, materiality }) => ({ key, label, materiality })) };
}
