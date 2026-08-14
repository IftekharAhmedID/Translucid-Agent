import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const sourceSpanSchema = z.object({ page: z.number().int().positive().optional(), text: z.string().min(1) }).strict();
const evidenceSelectorSchema = z.object({
  sourceRef: z.string().regex(/^S[1-9]\d*$/).optional(),
  sourceSha256: sha256.optional(),
  exactQuote: z.string().min(1),
  relation: z.enum(["SUPPORTS", "CONTRADICTS"]),
}).strict().refine(({ sourceRef, sourceSha256 }) => sourceRef !== undefined || sourceSha256 !== undefined, "Evidence selector requires sourceRef or sourceSha256.");
const forbiddenMappingSchema = z.object({
  facetKey: z.string().min(1).optional(),
  sourceRef: z.string().regex(/^S[1-9]\d*$/).optional(),
  sourceSha256: sha256.optional(),
  exactQuote: z.string().min(1).optional(),
  relation: z.enum(["SUPPORTS", "CONTRADICTS"]).optional(),
}).strict().refine((value) => Object.values(value).some((item) => item !== undefined), "Forbidden mapping cannot be empty.");

export const v5GoldManifestSchema = z.object({
  schemaVersion: z.literal(1),
  assertions: z.array(z.object({
    assertionId: z.string().min(1).max(200),
    sourceSpan: sourceSpanSchema,
    facetKey: z.string().min(1).max(200),
    expectedDisposition: z.enum(["SUPPORTED", "CONTRADICTED", "UNRESOLVED"]),
    acceptableEvidence: z.array(evidenceSelectorSchema).max(20).default([]),
    forbiddenMappings: z.array(forbiddenMappingSchema).max(50).default([]),
  }).strict()).min(1).max(2_000),
}).strict().superRefine(({ assertions }, context) => {
  const ids = new Set<string>();
  for (const [index, assertion] of assertions.entries()) {
    if (ids.has(assertion.assertionId)) context.addIssue({ code: "custom", path: ["assertions", index, "assertionId"], message: "Duplicate assertionId." });
    ids.add(assertion.assertionId);
    if (assertion.expectedDisposition !== "UNRESOLVED" && assertion.acceptableEvidence.length === 0) context.addIssue({ code: "custom", path: ["assertions", index, "acceptableEvidence"], message: "Resolved gold assertions require acceptable evidence." });
  }
});

const resultSchema = z.object({
  schemaVersion: z.literal("1.1"),
  run: z.object({ id: z.string().min(1) }).loose(),
  claims: z.array(z.object({
    id: z.string().min(1),
    sourceSpan: sourceSpanSchema,
    facets: z.array(z.object({ key: z.string().min(1), status: z.enum(["SUPPORTED", "CONTRADICTED", "UNRESOLVED"]), evidenceIds: z.array(z.string()) }).loose()),
  }).loose()),
  evidence: z.array(z.object({
    id: z.string().min(1),
    claimId: z.string().min(1),
    facetKeys: z.array(z.string().min(1)),
    relation: z.enum(["SUPPORTS", "CONTRADICTS"]),
    sourceRef: z.string().regex(/^S[1-9]\d*$/),
    exactQuote: z.string().min(1),
    sourceLocation: z.object({ path: z.string().min(1) }).loose(),
  }).loose()),
  sources: z.array(z.object({ ref: z.string().regex(/^S[1-9]\d*$/), sha256, relativePath: z.string().min(1), mimeType: z.string().min(1) }).loose()),
}).loose();
const sourceManifestSchema = z.object({ sources: z.array(z.object({
  ref: z.string().regex(/^S[1-9]\d*$/),
  sha256,
  relativePath: z.string().min(1),
  mimeType: z.string().min(1),
}).loose()) }).loose();

type GoldManifest = z.infer<typeof v5GoldManifestSchema>;
type Result = z.infer<typeof resultSchema>;
type EvidenceSelector = z.infer<typeof evidenceSelectorSchema>;
type ForbiddenMapping = z.infer<typeof forbiddenMappingSchema>;

function sourceSpanEqual(left: z.infer<typeof sourceSpanSchema>, right: z.infer<typeof sourceSpanSchema>): boolean {
  return left.page === right.page && left.text === right.text;
}

function selectorMatches(selector: EvidenceSelector | ForbiddenMapping, evidence: Result["evidence"][number], sourceSha256: string | undefined): boolean {
  return (selector.sourceRef === undefined || selector.sourceRef === evidence.sourceRef)
    && (selector.sourceSha256 === undefined || selector.sourceSha256 === sourceSha256)
    && (selector.exactQuote === undefined || selector.exactQuote === evidence.exactQuote)
    && (selector.relation === undefined || selector.relation === evidence.relation);
}

function inside(root: string, relativePath: string): string {
  const absolute = resolve(root, relativePath);
  if (!absolute.startsWith(`${root}/`)) throw new Error(`Source path escapes the run: ${relativePath}.`);
  return absolute;
}

function flatten(value: unknown, path = "", output: Array<{ path: string; text: string }> = [], depth = 0): Array<{ path: string; text: string }> {
  if (depth > 12 || value === null || value === undefined) return output;
  if (["string", "number", "boolean", "bigint"].includes(typeof value)) {
    output.push({ path: path || "$", text: String(value) });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${path}[${index}]`, output, depth + 1));
  } else if (typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) flatten(item, path ? `${path}.${key}` : key, output, depth + 1);
  }
  return output;
}

export type V5AcceptanceMetrics = {
  schemaVersion: 1;
  runId: string;
  passed: boolean;
  assertions: number;
  dispositionCoverage: { covered: number; total: number; rate: number };
  expectedDispositionMatches: { matched: number; total: number; rate: number };
  goldEvidenceRecall: { recalled: number; total: number; rate: number };
  artificialUnresolved: string[];
  missingAssertions: string[];
  dispositionMismatches: Array<{ assertionId: string; expected: string; actual: string }>;
  missingGoldEvidence: string[];
  forbiddenMappings: Array<{ assertionId: string; evidenceId: string }>;
  invalidSourceRefs: string[];
  sourceHashMismatches: string[];
  quoteMismatches: string[];
};

export async function evaluateV5Acceptance(runDirectory: string, goldValue: unknown): Promise<V5AcceptanceMetrics> {
  const root = resolve(runDirectory);
  const gold: GoldManifest = v5GoldManifestSchema.parse(goldValue);
  const result: Result = resultSchema.parse(JSON.parse(await readFile(resolve(root, "result.json"), "utf8")));
  const sourceManifest = sourceManifestSchema.parse(JSON.parse(await readFile(resolve(root, "sources", "manifest.json"), "utf8")));
  const storedSources = new Map(sourceManifest.sources.map((source) => [source.ref, source]));
  const resultSources = new Map(result.sources.map((source) => [source.ref, source]));
  const invalidSourceRefs = new Set(result.evidence.filter(({ sourceRef }) => !storedSources.has(sourceRef) || !resultSources.has(sourceRef)).map(({ sourceRef }) => sourceRef));
  for (const source of result.sources) {
    const stored = storedSources.get(source.ref);
    if (!stored || stored.relativePath !== source.relativePath || stored.mimeType !== source.mimeType || result.sources.filter(({ ref }) => ref === source.ref).length !== 1) invalidSourceRefs.add(source.ref);
  }
  for (const source of sourceManifest.sources) {
    if (!resultSources.has(source.ref) || sourceManifest.sources.filter(({ ref }) => ref === source.ref).length !== 1) invalidSourceRefs.add(source.ref);
  }
  const sourceHashMismatches = new Set(result.sources.filter((source) => storedSources.get(source.ref)?.sha256 !== source.sha256).map(({ ref }) => ref));
  const sourceBytes = new Map<string, Buffer>();
  for (const source of sourceManifest.sources) {
    try {
      const bytes = await readFile(inside(root, source.relativePath));
      sourceBytes.set(source.ref, bytes);
      if (createHash("sha256").update(bytes).digest("hex") !== source.sha256) sourceHashMismatches.add(source.ref);
    } catch {
      invalidSourceRefs.add(source.ref);
    }
  }
  const quoteMismatches: string[] = [];
  for (const evidence of result.evidence) {
    const source = storedSources.get(evidence.sourceRef);
    const bytes = sourceBytes.get(evidence.sourceRef);
    if (!source || !bytes) continue;
    let valid = false;
    if (source.mimeType.includes("json")) {
      const leaves = flatten(JSON.parse(bytes.toString("utf8")));
      valid = leaves.some((leaf) => leaf.path === evidence.sourceLocation.path && leaf.text.includes(evidence.exactQuote));
    } else if (evidence.sourceLocation.path === "$") {
      valid = bytes.toString("utf8").includes(evidence.exactQuote);
    }
    if (!valid) quoteMismatches.push(evidence.id);
  }

  let covered = 0;
  let dispositionMatched = 0;
  let recalled = 0;
  let recallTotal = 0;
  const artificialUnresolved: string[] = [];
  const missingAssertions: string[] = [];
  const dispositionMismatches: V5AcceptanceMetrics["dispositionMismatches"] = [];
  const missingGoldEvidence: string[] = [];
  const forbiddenMappings: V5AcceptanceMetrics["forbiddenMappings"] = [];
  for (const assertion of gold.assertions) {
    const matchingClaims = result.claims.filter((claim) => sourceSpanEqual(claim.sourceSpan, assertion.sourceSpan));
    const matches = matchingClaims.flatMap((claim) => claim.facets.filter(({ key }) => key === assertion.facetKey).map((facet) => ({ claim, facet })));
    if (matches.length !== 1) {
      missingAssertions.push(assertion.assertionId);
      if (assertion.expectedDisposition !== "UNRESOLVED") artificialUnresolved.push(assertion.assertionId);
      continue;
    }
    covered += 1;
    const [{ claim, facet }] = matches;
    if (facet.status === assertion.expectedDisposition) dispositionMatched += 1;
    else dispositionMismatches.push({ assertionId: assertion.assertionId, expected: assertion.expectedDisposition, actual: facet.status });
    if (assertion.expectedDisposition !== "UNRESOLVED" && facet.status === "UNRESOLVED") artificialUnresolved.push(assertion.assertionId);
    const edges = result.evidence.filter((evidence) => evidence.claimId === claim.id && evidence.facetKeys.includes(facet.key));
    if (assertion.expectedDisposition !== "UNRESOLVED") {
      recallTotal += 1;
      const found = assertion.acceptableEvidence.some((selector) => edges.some((evidence) => selectorMatches(selector, evidence, resultSources.get(evidence.sourceRef)?.sha256)));
      if (found) recalled += 1;
      else missingGoldEvidence.push(assertion.assertionId);
    }
    for (const forbidden of assertion.forbiddenMappings) {
      const found = result.evidence.find((evidence) => evidence.claimId === claim.id
        && (forbidden.facetKey === undefined ? evidence.facetKeys.includes(facet.key) : evidence.facetKeys.includes(forbidden.facetKey))
        && selectorMatches(forbidden, evidence, resultSources.get(evidence.sourceRef)?.sha256));
      if (found) forbiddenMappings.push({ assertionId: assertion.assertionId, evidenceId: found.id });
    }
  }
  const rate = (numerator: number, denominator: number) => denominator === 0 ? 1 : numerator / denominator;
  const passed = covered === gold.assertions.length
    && dispositionMatched === gold.assertions.length
    && recalled === recallTotal
    && artificialUnresolved.length === 0
    && forbiddenMappings.length === 0
    && invalidSourceRefs.size === 0
    && sourceHashMismatches.size === 0
    && quoteMismatches.length === 0;
  return {
    schemaVersion: 1,
    runId: result.run.id,
    passed,
    assertions: gold.assertions.length,
    dispositionCoverage: { covered, total: gold.assertions.length, rate: rate(covered, gold.assertions.length) },
    expectedDispositionMatches: { matched: dispositionMatched, total: gold.assertions.length, rate: rate(dispositionMatched, gold.assertions.length) },
    goldEvidenceRecall: { recalled, total: recallTotal, rate: rate(recalled, recallTotal) },
    artificialUnresolved: [...new Set(artificialUnresolved)],
    missingAssertions,
    dispositionMismatches,
    missingGoldEvidence,
    forbiddenMappings,
    invalidSourceRefs: [...invalidSourceRefs].sort((left, right) => Number(left.slice(1)) - Number(right.slice(1))),
    sourceHashMismatches: [...sourceHashMismatches].sort((left, right) => Number(left.slice(1)) - Number(right.slice(1))),
    quoteMismatches,
  };
}

function parseArguments(argv: readonly string[]): { runDirectory: string; goldPath: string } {
  let runDirectory: string | undefined;
  let goldPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--run-dir") runDirectory = argv[++index];
    else if (value === "--gold") goldPath = argv[++index];
    else throw new Error(`Unknown acceptance argument: ${value}.`);
  }
  if (!runDirectory || !goldPath) throw new Error("Usage: npm run acceptance:v5 -- --run-dir <path> --gold <path>");
  return { runDirectory, goldPath };
}

async function main(): Promise<void> {
  const { runDirectory, goldPath } = parseArguments(process.argv.slice(2));
  const metrics = await evaluateV5Acceptance(runDirectory, JSON.parse(await readFile(resolve(goldPath), "utf8")));
  process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
  if (!metrics.passed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
