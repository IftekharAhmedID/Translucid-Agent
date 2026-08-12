import { createHash } from "node:crypto";

import { z } from "zod";

import { investigationDraftSchema, type InvestigationDraft } from "./result-contract.ts";

const key = z.string().min(1).max(200);
const facetKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const materiality = z.enum(["HIGH", "MEDIUM", "LOW"]);

export const coverageSpanSchema = z.object({
  page: z.number().int().positive(),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  text: z.string().min(1).max(20_000),
}).strict();

const claimedCoverageSchema = z.object({
  span: coverageSpanSchema,
  disposition: z.literal("CLAIMED"),
  claimKey: key,
}).strict();

const excludedCoverageSchema = z.object({
  span: coverageSpanSchema,
  disposition: z.literal("EXCLUDED"),
  reason: z.enum(["CONTACT_DETAIL", "SECTION_HEADING", "BARE_SKILL", "SUBJECTIVE_DESCRIPTION", "DUPLICATE"]),
}).strict();

export const coverageItemSchema = z.discriminatedUnion("disposition", [claimedCoverageSchema, excludedCoverageSchema]);

export const claimOutlineSchema = z.object({
  key,
  category: z.enum(["IDENTITY", "EMPLOYMENT", "PROJECT", "CONTRIBUTION", "EDUCATION", "EVENT", "PUBLICATION", "AFFILIATION", "OTHER"]),
  statement: z.string().min(1).max(8_000),
  materiality,
  sourceSpan: z.object({ page: z.number().int().positive(), lineStart: z.number().int().positive(), lineEnd: z.number().int().positive(), text: z.string().min(1).max(20_000) }).strict(),
  facets: z.array(z.object({ key: facetKey, label: z.string().min(1).max(500), materiality }).strict()).min(1).max(12),
}).strict();

export const coveragePlanSchema = z.object({
  claims: z.array(claimOutlineSchema).min(1).max(500),
  coverage: z.array(coverageItemSchema).min(1).max(2_000),
}).strict();

export const compiledClaimSchema = z.object({
  claimKey: key,
  explanation: z.string().min(1).max(8_000),
  facets: z.array(z.object({ key: facetKey, note: z.string().min(1).max(2_000) }).strict()).min(1).max(12),
}).strict();

export const packetEvidenceSchema = z.object({
  key,
  claimKey: key,
  facetKeys: z.array(facetKey).min(1).max(12),
  relation: z.enum(["SUPPORTS", "CONTRADICTS"]),
  sourceRef: z.string().regex(/^S[1-9]\d*$/),
  exactQuote: z.string().min(1).max(80_000),
  sourceLocation: z.object({ path: z.string().min(1).max(2_000) }).catchall(z.unknown()),
}).strict();

export const packetSchema = z.object({
  claims: z.array(compiledClaimSchema).min(1).max(5),
  evidence: z.array(packetEvidenceSchema).max(5_000),
}).strict();

export const summaryTimelineSchema = investigationDraftSchema.shape.summary;
export const timelineSchema = investigationDraftSchema.shape.timeline;
export const summaryTimelineOutputSchema = z.object({
  summary: summaryTimelineSchema,
  timeline: timelineSchema,
}).strict();

export type CoveragePlan = z.infer<typeof coveragePlanSchema>;
export type CoverageItem = z.infer<typeof coverageItemSchema>;
export type ClaimOutline = z.infer<typeof claimOutlineSchema>;
export type Packet = z.infer<typeof packetSchema>;
export type PacketEvidence = z.infer<typeof packetEvidenceSchema>;
export type SummaryTimeline = z.infer<typeof summaryTimelineSchema>;
export type TimelineEntry = z.infer<typeof timelineSchema>[number];

export type PacketDossier = {
  formatVersion: "2";
  coverage: CoverageItem[];
  claims: Array<ClaimOutline & { explanation: string; facets: Array<ClaimOutline["facets"][number] & { note: string }> }>;
  evidence: PacketEvidence[];
  summary: SummaryTimeline;
  timeline: TimelineEntry[];
};

type InputPage = { page: number; lines: Array<{ line: number; text: string }>; text?: string };
type InputDocument = { pages: InputPage[] };

function pageByNumber(input: InputDocument): Map<number, InputPage> {
  return new Map(input.pages.map((page) => [page.page, page]));
}

function spanText(page: InputPage, start: number, end: number): string {
  const lines = page.lines.filter((line) => line.line >= start && line.line <= end);
  if (lines.length !== end - start + 1 || lines[0]?.line !== start || lines.at(-1)?.line !== end) {
    throw new Error(`Coverage span line ${start}-${end} is not present on page ${page.page}.`);
  }
  return lines.map((line) => line.text).join("\n");
}

function likelyFactualAssertion(text: string): boolean {
  return /\b(?:19\d{2}|20\d{2}|worked|engineer|developer|founded|built|created|led|managed|published|degree|university|company|employer|employment|experience|contributed|maintained|served|at)\b/i.test(text);
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label} ${value}.`);
    seen.add(value);
  }
}

export function validateCoveragePlan(value: unknown, input: InputDocument): CoveragePlan {
  const plan = coveragePlanSchema.parse(value);
  const pages = pageByNumber(input);
  assertUnique(plan.claims.map((claim) => claim.key), "claim key");
  const claimByKey = new Map(plan.claims.map((claim) => [claim.key, claim]));
  for (const claim of plan.claims) {
    assertUnique(claim.facets.map((facet) => facet.key), `facet key on ${claim.key}`);
    const page = pages.get(claim.sourceSpan.page);
    if (!page) throw new Error(`Claim ${claim.key} references unknown page ${claim.sourceSpan.page}.`);
    if (page) {
      const actual = spanText(page, claim.sourceSpan.lineStart, claim.sourceSpan.lineEnd);
      if (actual !== claim.sourceSpan.text) throw new Error(`Claim ${claim.key} source span lines do not match input text.`);
    }
  }

  const covered = new Map<string, CoverageItem>();
  const claimedKeys = new Set<string>();
  for (const item of plan.coverage) {
    const page = pages.get(item.span.page);
    if (!page) throw new Error(`Coverage references unknown page ${item.span.page}.`);
    const actual = spanText(page, item.span.lineStart, item.span.lineEnd);
    if (actual !== item.span.text) throw new Error(`Coverage span on page ${item.span.page} lines ${item.span.lineStart}-${item.span.lineEnd} does not match input text.`);
    if (item.disposition === "CLAIMED" && !claimByKey.has(item.claimKey)) {
      throw new Error(`Coverage references unknown claim ${item.claimKey}.`);
    }
    if (item.disposition === "CLAIMED") claimedKeys.add(item.claimKey);
    if (item.disposition === "EXCLUDED") {
      if (item.reason === "DUPLICATE") {
        const occurrences = input.pages.flatMap((candidate) => candidate.lines).filter((line) => line.text === item.span.text).length;
        if (occurrences < 2) throw new Error(`Coverage exclusion DUPLICATE is not supported by repeated input text at page ${item.span.page} line ${item.span.lineStart}.`);
      } else if (item.reason === "SUBJECTIVE_DESCRIPTION" && likelyFactualAssertion(item.span.text)) {
        throw new Error(`Coverage marks a likely factual assertion as ${item.reason} at page ${item.span.page} line ${item.span.lineStart}; it must be a claim.`);
      }
    }
    for (let line = item.span.lineStart; line <= item.span.lineEnd; line += 1) {
      const token = `${item.span.page}:${line}`;
      if (covered.has(token)) throw new Error(`Overlapping coverage at page ${item.span.page} line ${line}.`);
      covered.set(token, item);
    }
  }
  for (const page of input.pages) {
    for (const line of page.lines) {
      if (!line.text.trim()) continue;
      if (!covered.has(`${page.page}:${line.line}`)) throw new Error(`Missing coverage for page ${page.page} line ${line.line}.`);
    }
  }
  for (const claim of plan.claims) {
    if (!claimedKeys.has(claim.key)) throw new Error(`Claim ${claim.key} is not represented in the coverage ledger.`);
    for (let line = claim.sourceSpan.lineStart; line <= claim.sourceSpan.lineEnd; line += 1) {
      const item = covered.get(`${claim.sourceSpan.page}:${line}`);
      if (!item || item.disposition !== "CLAIMED" || item.claimKey !== claim.key) {
        throw new Error(`Claim ${claim.key} source span is not represented by its claimed coverage.`);
      }
    }
  }
  return plan;
}

export function splitClaimPackets(outlines: ClaimOutline[], maxClaims = 5): ClaimOutline[][] {
  if (!Number.isInteger(maxClaims) || maxClaims < 1) throw new Error("Packet size must be a positive integer.");
  const packets: ClaimOutline[][] = [];
  for (let index = 0; index < outlines.length; index += maxClaims) packets.push(outlines.slice(index, index + maxClaims));
  return packets;
}

export function validatePacket(value: unknown, outlines: ClaimOutline[], allowedSourceRefs: ReadonlySet<string>): Packet {
  const packet = packetSchema.parse(value);
  const outlineByKey = new Map(outlines.map((outline) => [outline.key, outline]));
  const expectedKeys = outlines.map((outline) => outline.key);
  assertUnique(packet.claims.map((claim) => claim.claimKey), "packet claim");
  if (packet.claims.length !== outlines.length || packet.claims.some((claim) => !outlineByKey.has(claim.claimKey)) || expectedKeys.some((keyValue) => !packet.claims.some((claim) => claim.claimKey === keyValue))) {
    throw new Error("Packet claims do not exactly match its assigned claim outlines.");
  }
  const facetSets = new Map(outlines.map((outline) => [outline.key, new Set(outline.facets.map((facet) => facet.key))]));
  for (const compiled of packet.claims) {
    const expected = facetSets.get(compiled.claimKey)!;
    const actual = compiled.facets.map((facet) => facet.key);
    assertUnique(actual, `packet facet on ${compiled.claimKey}`);
    if (actual.length !== expected.size || actual.some((facet) => !expected.has(facet))) throw new Error(`Packet facets do not exactly match claim ${compiled.claimKey}.`);
  }
  assertUnique(packet.evidence.map((item) => item.key), "evidence key");
  for (const evidence of packet.evidence) {
    if (!outlineByKey.has(evidence.claimKey)) throw new Error(`Evidence ${evidence.key} references a claim outside this packet.`);
    const declared = facetSets.get(evidence.claimKey)!;
    if (evidence.facetKeys.some((facet) => !declared.has(facet))) throw new Error(`Evidence ${evidence.key} references a neighboring or unknown facet.`);
    if (!allowedSourceRefs.has(evidence.sourceRef)) throw new Error(`Evidence ${evidence.key} references unknown source ${evidence.sourceRef}.`);
    if (!evidence.sourceLocation.path) throw new Error(`Evidence ${evidence.key} is missing an exact source path.`);
  }
  return packet;
}

function validateSummary(summaryValue: unknown, timelineValue: unknown, claimKeys: Set<string>, evidenceKeys: Set<string>, claimFacets: Map<string, Set<string>>, evidenceClaims: Map<string, string>): { summary: SummaryTimeline; timeline: TimelineEntry[] } {
  const summary = summaryTimelineSchema.parse(summaryValue);
  const timeline = timelineSchema.parse(timelineValue);
  const checkClaims = (values: string[], label: string) => values.forEach((value) => { if (!claimKeys.has(value)) throw new Error(`${label} references unknown claim ${value}.`); });
  const checkEvidence = (values: string[], label: string, allowedClaims?: Set<string>) => values.forEach((value) => {
    if (!evidenceKeys.has(value)) throw new Error(`${label} references unknown evidence ${value}.`);
    if (allowedClaims && !allowedClaims.has(evidenceClaims.get(value) ?? "")) throw new Error(`${label} crosses claim boundaries through evidence ${value}.`);
  });
  const checkClaimFacets = (claimKeyValue: string, values: string[], label: string) => {
    const declared = claimFacets.get(claimKeyValue) ?? new Set<string>();
    values.forEach((value) => { if (!declared.has(value)) throw new Error(`${label} references unknown facet ${value} on claim ${claimKeyValue}.`); });
  };
  checkClaims(summary.professionalIdentity.claimKeys, "Summary identity");
  checkEvidence(summary.professionalIdentity.evidenceKeys, "Summary identity", new Set(summary.professionalIdentity.claimKeys));
  checkClaims(summary.timelineClaimKeys, "Summary timeline");
  checkEvidence(summary.timelineEvidenceKeys, "Summary timeline", new Set(summary.timelineClaimKeys));
  for (const item of summary.strongestEvidenceByClaim) {
    if (!claimKeys.has(item.claimKey)) throw new Error(`Summary strongest evidence references unknown claim ${item.claimKey}.`);
    checkClaimFacets(item.claimKey, item.facetKeys, `Summary strongest evidence ${item.claimKey}`);
    checkEvidence(item.evidenceKeys, `Summary strongest evidence ${item.claimKey}`, new Set([item.claimKey]));
  }
  for (const item of summary.materialInconsistencies) {
    if (!claimKeys.has(item.claimKey)) throw new Error(`Summary inconsistency references unknown claim ${item.claimKey}.`);
    checkEvidence(item.evidenceKeys, `Summary inconsistency ${item.claimKey}`, new Set([item.claimKey]));
  }
  for (const item of timeline) {
    checkClaims(item.claimKeys, "Timeline");
    checkEvidence(item.evidenceKeys, "Timeline", new Set(item.claimKeys));
  }
  return { summary, timeline };
}

export function mergePacketDossier(planValue: unknown, packetValues: unknown[], summaryValue: unknown, timelineValue: unknown, allowedSourceRefs?: ReadonlySet<string>): PacketDossier {
  const plan = coveragePlanSchema.parse(planValue);
  const packetSourceRefs = new Set(
    (packetValues.flatMap((value) => (value as { evidence?: Array<{ sourceRef?: string }> }).evidence ?? [])).map((item) => item.sourceRef).filter((value): value is string => typeof value === "string"),
  );
  const packets = packetValues.map((packetValue, index) => validatePacket(packetValue, splitClaimPackets(plan.claims)[index] ?? [], allowedSourceRefs ?? packetSourceRefs));
  const expectedPackets = splitClaimPackets(plan.claims);
  if (packets.length !== expectedPackets.length) throw new Error(`Expected ${expectedPackets.length} packet(s), received ${packets.length}.`);
  const claims = expectedPackets.flatMap((outlines, index) => {
    const packet = packets[index]!;
    return outlines.map((outline) => {
      const compiled = packet.claims.find((claim) => claim.claimKey === outline.key)!;
      return { ...outline, explanation: compiled.explanation, facets: outline.facets.map((facet) => ({ ...facet, note: compiled.facets.find((item) => item.key === facet.key)!.note })) };
    });
  });
  const evidence = packets.flatMap((packet) => packet.evidence);
  assertUnique(evidence.map((item) => item.key), "evidence key");
  const claimKeys = new Set(claims.map((claim) => claim.key));
  const evidenceKeys = new Set(evidence.map((item) => item.key));
  const claimFacets = new Map(claims.map((claim) => [claim.key, new Set(claim.facets.map((facet) => facet.key))]));
  const evidenceClaims = new Map(evidence.map((item) => [item.key, item.claimKey]));
  const { summary, timeline } = validateSummary(summaryValue, timelineValue, claimKeys, evidenceKeys, claimFacets, evidenceClaims);
  return { formatVersion: "2", coverage: plan.coverage, claims, evidence, summary, timeline };
}

function canonical(value: unknown, path: string[] = []): unknown {
  if (Array.isArray(value)) {
    const normalizedItems = value.map((item) => canonical(item, [...path, "[]"]));
    const last = path.at(-1) ?? "";
    const sortSet = last === "coverage" || last === "claims" || last === "evidence" || last === "facets" || last === "strongestEvidenceByClaim" || last === "materialInconsistencies";
    const sortKeys = last.endsWith("Keys") || last === "facetKeys";
    if (sortSet || sortKeys) return normalizedItems.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return normalizedItems;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([keyValue, child]) => [keyValue, canonical(child, [...path, keyValue])]));
  }
  return value;
}

export function dossierFingerprint(dossier: PacketDossier): string {
  return createHash("sha256").update(JSON.stringify(canonical(dossier))).digest("hex");
}

export function packetDossierToDraft(dossier: PacketDossier): InvestigationDraft {
  return investigationDraftSchema.parse({
    summary: dossier.summary,
    claims: dossier.claims.map((claim) => ({ ...claim, sourceSpan: { page: claim.sourceSpan.page, text: claim.sourceSpan.text }, facets: claim.facets.map((facet) => ({ ...facet, status: "UNRESOLVED" })) })),
    evidence: dossier.evidence,
    timeline: dossier.timeline,
  });
}

export function renderEvidenceDossierMarkdown(dossier: PacketDossier): string {
  const lines = ["# Evidence dossier", "", `Format version: ${dossier.formatVersion}`, "", "## Coverage", ""];
  for (const item of dossier.coverage) lines.push(`- ${item.span.page}:${item.span.lineStart}-${item.span.lineEnd} ${item.disposition === "CLAIMED" ? `CLAIMED ${item.claimKey}` : `EXCLUDED ${item.reason}`}: ${item.span.text}`);
  lines.push("", "## Claims", "");
  for (const claim of dossier.claims) {
    lines.push(`### ${claim.key}: ${claim.statement}`, "", claim.explanation, "");
    for (const facet of claim.facets) lines.push(`- ${facet.key} (${facet.materiality}): ${facet.label} — ${facet.note}`);
    for (const evidence of dossier.evidence.filter((item) => item.claimKey === claim.key)) lines.push(`- Evidence ${evidence.key} [${evidence.relation}] ${evidence.sourceRef} ${evidence.sourceLocation.path}: ${evidence.exactQuote}`);
    lines.push("");
  }
  lines.push("## Summary", "", dossier.summary.professionalTimelineSummary, "", "## Timeline", "");
  for (const item of dossier.timeline) lines.push(`- ${item.label}: ${item.claimKeys.join(", ")} (${item.evidenceKeys.join(", ")})`);
  return `${lines.join("\n")}\n`;
}
