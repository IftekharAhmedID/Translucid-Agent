import { createHash } from "node:crypto";

import { z } from "zod";

import { investigationDraftSchema, type InvestigationDraft } from "./result-contract.ts";

export const EVIDENCE_DOSSIER_FORMAT_VERSION = "1";

const key = z.string().min(1).max(200);
const facetKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const materiality = z.enum(["HIGH", "MEDIUM", "LOW"]);
const sourceSpan = z.object({
  page: z.number().int().positive().optional(),
  text: z.string().min(1).max(20_000),
}).strict();

const claimRecordSchema = z.object({
  key,
  category: z.enum(["IDENTITY", "EMPLOYMENT", "PROJECT", "CONTRIBUTION", "EDUCATION", "EVENT", "PUBLICATION", "AFFILIATION", "OTHER"]),
  statement: z.string().min(1).max(8_000),
  materiality,
  sourceSpan,
  explanation: z.string().min(1).max(8_000),
}).strict();

const facetRecordSchema = z.object({
  claimKey: key,
  key: facetKey,
  label: z.string().min(1).max(500),
  materiality,
  note: z.string().min(1).max(2_000),
}).strict();

const evidenceRecordSchema = z.object({
  key,
  claimKey: key,
  facetKeys: z.array(facetKey).min(1).max(12),
  relation: z.enum(["SUPPORTS", "CONTRADICTS"]),
  sourceRef: z.string().regex(/^S[1-9]\d*$/),
  exactQuote: z.string().min(1).max(80_000),
  sourceLocation: z.record(z.string(), z.unknown()),
}).strict();

const summaryRecordSchema = investigationDraftSchema.shape.summary;
const timelineRecordSchema = investigationDraftSchema.shape.timeline.element;

const coverageBaseSchema = z.object({
  assertion: z.string().min(1).max(8_000),
  sourceSpan,
}).strict();

const coverageRecordSchema = z.discriminatedUnion("disposition", [
  coverageBaseSchema.extend({
    disposition: z.enum(["CLAIMED", "UNRESOLVED"]),
    claimKey: key,
  }).strict(),
  coverageBaseSchema.extend({
    disposition: z.literal("EXCLUDED_LOW_MATERIALITY"),
    reason: z.string().trim().min(1).max(2_000),
  }).strict(),
]);

type ClaimRecord = z.infer<typeof claimRecordSchema>;
type FacetRecord = z.infer<typeof facetRecordSchema>;
type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;
type SummaryRecord = z.infer<typeof summaryRecordSchema>;
type TimelineRecord = z.infer<typeof timelineRecordSchema>;
type CoverageRecord = z.infer<typeof coverageRecordSchema>;

export type DossierRecord =
  | { type: "TL_CLAIM"; value: ClaimRecord }
  | { type: "TL_FACET"; value: FacetRecord }
  | { type: "TL_EVIDENCE"; value: EvidenceRecord }
  | { type: "TL_SUMMARY"; value: SummaryRecord }
  | { type: "TL_TIMELINE"; value: TimelineRecord }
  | { type: "TL_COVERAGE"; value: CoverageRecord };

export type DossierInventory = {
  claims: ClaimRecord[];
  facets: FacetRecord[];
  evidence: EvidenceRecord[];
  summary: SummaryRecord;
  timeline: TimelineRecord[];
  coverage: CoverageRecord[];
};

const recordSchemas = {
  TL_CLAIM: claimRecordSchema,
  TL_FACET: facetRecordSchema,
  TL_EVIDENCE: evidenceRecordSchema,
  TL_SUMMARY: summaryRecordSchema,
  TL_TIMELINE: timelineRecordSchema,
  TL_COVERAGE: coverageRecordSchema,
} as const;

type RecordType = keyof typeof recordSchemas;
const recordPrefix = /^(TL_[A-Z_]+)\s+(.+)$/;
const maximumDossierCharacters = 20_000_000;
const maximumRecordCharacters = 200_000;
const setLikeArrayKeys = new Set(["claimKeys", "evidenceKeys", "facetKeys"]);
const recordSetArrayKeys = new Set(["strongestEvidenceByClaim", "materialInconsistencies", "limitations"]);

function canonicalize(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    const normalized = value.map((item) => canonicalize(item));
    return setLikeArrayKeys.has(parentKey ?? "") || recordSetArrayKeys.has(parentKey ?? "")
      ? normalized.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
      : normalized;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([entryKey, entryValue]) => [entryKey, canonicalize(entryValue, entryKey)]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sortRecords<T>(values: T[]): T[] {
  return [...values].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function normalizedInventory(inventory: DossierInventory): DossierInventory {
  return {
    claims: sortRecords(inventory.claims),
    facets: sortRecords(inventory.facets),
    evidence: sortRecords(inventory.evidence),
    summary: canonicalize(inventory.summary) as SummaryRecord,
    timeline: sortRecords(inventory.timeline),
    coverage: sortRecords(inventory.coverage),
  };
}

function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}.`);
}

function parseRecord(type: RecordType, json: string, lineNumber: number): DossierRecord {
  if (json.length > maximumRecordCharacters) throw new Error(`Dossier record on line ${lineNumber} exceeds the maximum length.`);
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error(`Malformed ${type} JSON on line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return { type, value: recordSchemas[type].parse(value) } as DossierRecord;
  } catch (error) {
    throw new Error(`Invalid ${type} record on line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateInventory(inventory: DossierInventory, allowedSourceRefs: ReadonlySet<string>): void {
  unique(inventory.claims.map(({ key: claimKey }) => claimKey), "claim key");
  unique(inventory.evidence.map(({ key: evidenceKey }) => evidenceKey), "evidence key");
  unique(inventory.facets.map(({ claimKey, key: localKey }) => `${claimKey}\u0000${localKey}`), "facet key");
  unique(inventory.timeline.map(canonicalJson), "timeline record");
  unique(inventory.coverage.map(canonicalJson), "coverage record");

  const claims = new Set(inventory.claims.map(({ key: claimKey }) => claimKey));
  const facets = new Set(inventory.facets.map(({ claimKey, key: localKey }) => `${claimKey}\u0000${localKey}`));

  for (const facet of inventory.facets) {
    if (!claims.has(facet.claimKey)) throw new Error(`Facet ${facet.key} references unknown claim ${facet.claimKey}.`);
  }
  for (const item of inventory.evidence) {
    if (!claims.has(item.claimKey)) throw new Error(`Evidence ${item.key} references unknown claim ${item.claimKey}.`);
    unique(item.facetKeys, `facet key on evidence ${item.key}`);
    for (const localKey of item.facetKeys) {
      if (!facets.has(`${item.claimKey}\u0000${localKey}`)) throw new Error(`Evidence ${item.key} references unknown facet ${localKey}.`);
    }
    if (!allowedSourceRefs.has(item.sourceRef)) throw new Error(`Evidence ${item.key} references unknown source ${item.sourceRef}.`);
  }
  const evidence = new Set(inventory.evidence.map(({ key: evidenceKey }) => evidenceKey));
  for (const claimKey of inventory.summary.professionalIdentity.claimKeys) {
    if (!claims.has(claimKey)) throw new Error(`Professional identity summary references unknown claim ${claimKey}.`);
  }
  for (const evidenceKey of inventory.summary.professionalIdentity.evidenceKeys) {
    if (!evidence.has(evidenceKey)) throw new Error(`Professional identity summary references unknown evidence ${evidenceKey}.`);
  }
  for (const claimKey of inventory.summary.timelineClaimKeys) {
    if (!claims.has(claimKey)) throw new Error(`Timeline summary references unknown claim ${claimKey}.`);
  }
  for (const evidenceKey of inventory.summary.timelineEvidenceKeys) {
    if (!evidence.has(evidenceKey)) throw new Error(`Timeline summary references unknown evidence ${evidenceKey}.`);
  }
  for (const item of inventory.summary.strongestEvidenceByClaim) {
    if (!claims.has(item.claimKey)) throw new Error(`Strongest-evidence summary references unknown claim ${item.claimKey}.`);
    for (const localKey of item.facetKeys) {
      if (!facets.has(`${item.claimKey}\u0000${localKey}`)) throw new Error(`Strongest-evidence summary references unknown facet ${localKey}.`);
    }
    for (const evidenceKey of item.evidenceKeys) {
      if (!evidence.has(evidenceKey)) throw new Error(`Strongest-evidence summary references unknown evidence ${evidenceKey}.`);
    }
  }
  for (const item of inventory.summary.materialInconsistencies) {
    if (!claims.has(item.claimKey)) throw new Error(`Material-inconsistency summary references unknown claim ${item.claimKey}.`);
    for (const evidenceKey of item.evidenceKeys) {
      if (!evidence.has(evidenceKey)) throw new Error(`Material-inconsistency summary references unknown evidence ${evidenceKey}.`);
    }
  }
  for (const item of inventory.timeline) {
    for (const claimKey of item.claimKeys) if (!claims.has(claimKey)) throw new Error(`Timeline references unknown claim ${claimKey}.`);
    for (const evidenceKey of item.evidenceKeys) if (!evidence.has(evidenceKey)) throw new Error(`Timeline references unknown evidence ${evidenceKey}.`);
  }
  for (const item of inventory.coverage) {
    if (item.disposition !== "EXCLUDED_LOW_MATERIALITY" && !claims.has(item.claimKey)) {
      throw new Error(`Coverage item references unknown claim ${item.claimKey}.`);
    }
  }
}

export function parseEvidenceDossier(text: string, allowedSourceRefs: ReadonlySet<string>): DossierInventory {
  if (text.length > maximumDossierCharacters) throw new Error("Evidence dossier exceeds the maximum length.");
  const records: DossierRecord[] = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("TL_")) continue;
    const match = recordPrefix.exec(trimmed);
    if (!match) throw new Error(`Malformed dossier marker on line ${index + 1}.`);
    const type = match[1]!;
    if (!(type in recordSchemas)) throw new Error(`Unknown dossier marker ${type} on line ${index + 1}.`);
    records.push(parseRecord(type as RecordType, match[2]!, index + 1));
  }

  const summaries = records.filter((record): record is Extract<DossierRecord, { type: "TL_SUMMARY" }> => record.type === "TL_SUMMARY");
  if (summaries.length !== 1) throw new Error(`Evidence dossier must contain exactly one TL_SUMMARY record; found ${summaries.length}.`);

  const inventory: DossierInventory = {
    claims: records.filter((record): record is Extract<DossierRecord, { type: "TL_CLAIM" }> => record.type === "TL_CLAIM").map(({ value }) => value),
    facets: records.filter((record): record is Extract<DossierRecord, { type: "TL_FACET" }> => record.type === "TL_FACET").map(({ value }) => value),
    evidence: records.filter((record): record is Extract<DossierRecord, { type: "TL_EVIDENCE" }> => record.type === "TL_EVIDENCE").map(({ value }) => value),
    summary: summaries[0]!.value,
    timeline: records.filter((record): record is Extract<DossierRecord, { type: "TL_TIMELINE" }> => record.type === "TL_TIMELINE").map(({ value }) => value),
    coverage: records.filter((record): record is Extract<DossierRecord, { type: "TL_COVERAGE" }> => record.type === "TL_COVERAGE").map(({ value }) => value),
  };
  if (inventory.claims.length === 0) throw new Error("Evidence dossier contains no TL_CLAIM records.");
  if (inventory.coverage.length === 0) throw new Error("Evidence dossier contains no TL_COVERAGE records.");
  validateInventory(inventory, allowedSourceRefs);
  return inventory;
}

function draftSemanticInventory(value: InvestigationDraft): Omit<DossierInventory, "coverage"> {
  const draft = investigationDraftSchema.parse(value);
  return {
    claims: draft.claims.map((claim) => ({
      key: claim.key,
      category: claim.category,
      statement: claim.statement,
      materiality: claim.materiality,
      sourceSpan: claim.sourceSpan,
      explanation: claim.explanation,
    })),
    facets: draft.claims.flatMap((claim) => claim.facets.map((facet) => ({
      claimKey: claim.key,
      key: facet.key,
      label: facet.label,
      materiality: facet.materiality,
      note: facet.note,
    }))),
    evidence: draft.evidence,
    summary: draft.summary,
    timeline: draft.timeline,
  };
}

export function assertDossierMatchesDraft(inventory: DossierInventory, value: InvestigationDraft): void {
  const expected = normalizedInventory({ ...draftSemanticInventory(value), coverage: inventory.coverage });
  const actual = normalizedInventory(inventory);
  for (const section of ["claims", "facets", "evidence", "summary", "timeline"] as const) {
    if (canonicalJson(actual[section]) !== canonicalJson(expected[section])) {
      throw new Error(`Structured encoding changed dossier ${section} semantics.`);
    }
  }
}

export function dossierFingerprint(inventory: DossierInventory): string {
  return createHash("sha256").update(canonicalJson(normalizedInventory(inventory))).digest("hex");
}
