import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { LeanReportResult } from "./report-store.ts";
import type { CapturedSourceMetadata } from "./source-store.ts";

export const factGroupStatuses = ["MISSING", "DISCOVERED", "CAPTURED", "CITED"] as const;
export type FactGroupStatus = typeof factGroupStatuses[number];

export type FactGroup = {
  id: string;
  predicate: string;
  canonicalWitnessFamily: string;
  canonicalHostAliases: string[];
  canonicalPathAliases?: string[];
  subjectMatchers: string[];
  predicateMatchers: string[];
  required: boolean;
};

export type SemanticReviewCase = {
  id: string;
  description: string;
  targetIds: string[];
  acceptableStatuses: Array<"ESTABLISHED" | "PARTIAL" | "UNRESOLVED" | "CONFLICTING" | "CONTRADICTED">;
};

export type FactGroupFixture = {
  schemaVersion: 1;
  case: string;
  groups: FactGroup[];
  semanticReviewCases: SemanticReviewCase[];
};

export type EvaluationSource = Pick<CapturedSourceMetadata, "ref" | "kind" | "sourceUrl" | "title" | "highlight" | "provenance"> & { content?: string };

export type FactGroupEvaluation = {
  id: string;
  predicate: string;
  canonicalWitnessFamily: string;
  required: boolean;
  status: FactGroupStatus;
  discoveredRefs: string[];
  capturedRefs: string[];
  citedRefs: string[];
};

export type SemanticReviewEvaluation = {
  id: string;
  description: string;
  status: "PASS" | "FAIL" | "REQUIRES_HUMAN_REVIEW";
  matchedTargetIds: string[];
  observedStatuses: string[];
};

export type QualificationEvaluation = {
  qualification: "PASS" | "FAIL" | "REQUIRES_HUMAN_REVIEW";
  factGroups: FactGroupEvaluation[];
  semanticReview: SemanticReviewEvaluation[];
  requiredMissing: string[];
  requiredUncaptured: string[];
};

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function normalizeSourceUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    url.protocol = url.protocol.toLocaleLowerCase("en-US");
    url.hostname = url.hostname.toLocaleLowerCase("en-US");
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
    return url.toString();
  } catch {
    return value.trim().toLocaleLowerCase("en-US").replace(/#.*$/, "").replace(/\/$/, "");
  }
}

function sourceUrls(source: EvaluationSource): string[] {
  const provenance = source.provenance ?? {};
  return [
    source.sourceUrl,
    typeof provenance.requestedUrl === "string" ? provenance.requestedUrl : undefined,
    typeof provenance.finalUrl === "string" ? provenance.finalUrl : undefined,
    typeof provenance.redirectUrl === "string" ? provenance.redirectUrl : undefined,
    typeof provenance.canonicalSourceUrl === "string" ? provenance.canonicalSourceUrl : undefined,
  ].filter((value): value is string => Boolean(value)).map(normalizeSourceUrl);
}

function sourceText(source: EvaluationSource): string {
  return normalizeText([source.title, source.highlight, source.content].filter((value): value is string => Boolean(value)).join("\n"));
}

function includesEveryMatcher(text: string, matchers: string[]): boolean {
  return matchers.length > 0 && matchers.every((matcher) => text.includes(normalizeText(matcher)));
}

function includesAnyMatcher(text: string, matchers: string[]): boolean {
  return matchers.length > 0 && matchers.some((matcher) => text.includes(normalizeText(matcher)));
}

function isCanonicalWitness(source: EvaluationSource, group: FactGroup): boolean {
  const aliases = group.canonicalHostAliases.map((alias) => alias.toLocaleLowerCase("en-US").replace(/^https?:\/\//, "").replace(/\/$/, ""));
  const paths = (group.canonicalPathAliases ?? []).map((path) => path === "/" ? "/" : path.replace(/\/$/, ""));
  return sourceUrls(source).some((candidate) => {
    try {
      const url = new URL(candidate);
      const hostMatches = aliases.some((alias) => url.hostname === alias || url.hostname.endsWith(`.${alias}`));
      if (!hostMatches) return false;
      return paths.length === 0 || paths.some((path) => path === "/" || url.pathname === path || url.pathname.startsWith(`${path}/`));
    } catch {
      return false;
    }
  });
}

function sourceSupports(source: EvaluationSource, group: FactGroup): boolean {
  const text = sourceText(source);
  return includesAnyMatcher(text, group.subjectMatchers) && includesAnyMatcher(text, group.predicateMatchers);
}

export function evaluateFactGroups(groups: FactGroup[], sources: EvaluationSource[], citedSourceRefs: Iterable<string>): FactGroupEvaluation[] {
  const cited = new Set(citedSourceRefs);
  return groups.map((group) => {
    const discovered = sources.filter((source) => sourceSupports(source, group) && source.kind === "SEARCH_DISCOVERY");
    const captured = sources.filter((source) => sourceSupports(source, group) && source.kind !== "SEARCH_DISCOVERY" && isCanonicalWitness(source, group));
    const citedCaptured = captured.filter((source) => cited.has(source.ref));
    const status: FactGroupStatus = captured.length > 0
      ? citedCaptured.length > 0 ? "CITED" : "CAPTURED"
      : discovered.length > 0 ? "DISCOVERED" : "MISSING";
    return {
      id: group.id,
      predicate: group.predicate,
      canonicalWitnessFamily: group.canonicalWitnessFamily,
      required: group.required,
      status,
      discoveredRefs: discovered.map(({ ref }) => ref),
      capturedRefs: captured.map(({ ref }) => ref),
      citedRefs: citedCaptured.map(({ ref }) => ref),
    };
  });
}

function statusLabel(status: -2 | -1 | 0 | 1 | 2): "ESTABLISHED" | "PARTIAL" | "UNRESOLVED" | "CONFLICTING" | "CONTRADICTED" {
  return ({ 2: "ESTABLISHED", 1: "PARTIAL", 0: "UNRESOLVED", [-1]: "CONFLICTING", [-2]: "CONTRADICTED" } as const)[status];
}

export function evaluateSemanticReview(cases: SemanticReviewCase[], result: Pick<LeanReportResult, "findings">): SemanticReviewEvaluation[] {
  return cases.map((reviewCase) => {
    const matches = result.findings.filter((finding) => reviewCase.targetIds.includes(finding.findingId));
    if (matches.length === 0) return { id: reviewCase.id, description: reviewCase.description, status: "REQUIRES_HUMAN_REVIEW", matchedTargetIds: [], observedStatuses: [] };
    const observedStatuses = [...new Set(matches.map((finding) => statusLabel(finding.status)))];
    const status = matches.every((finding) => reviewCase.acceptableStatuses.includes(statusLabel(finding.status))) ? "PASS" : "FAIL";
    return { id: reviewCase.id, description: reviewCase.description, status, matchedTargetIds: matches.map(({ findingId }) => findingId), observedStatuses };
  });
}

export function evaluateQualification(input: { fixture: FactGroupFixture; sources: EvaluationSource[]; citedSourceRefs: Iterable<string>; result: Pick<LeanReportResult, "findings"> }): QualificationEvaluation {
  const factGroups = evaluateFactGroups(input.fixture.groups, input.sources, input.citedSourceRefs);
  const semanticReview = evaluateSemanticReview(input.fixture.semanticReviewCases, input.result);
  const requiredMissing = factGroups.filter((group) => group.required && group.status === "MISSING").map(({ id }) => id);
  const requiredUncaptured = factGroups.filter((group) => group.required && !["CAPTURED", "CITED"].includes(group.status)).map(({ id }) => id);
  const qualification = semanticReview.some(({ status }) => status === "FAIL") || requiredMissing.length > 0
    ? "FAIL"
    : semanticReview.some(({ status }) => status === "REQUIRES_HUMAN_REVIEW") || requiredUncaptured.length > 0
      ? "REQUIRES_HUMAN_REVIEW"
      : "PASS";
  return { qualification, factGroups, semanticReview, requiredMissing, requiredUncaptured };
}

export async function loadDiegoFactGroupFixture(): Promise<FactGroupFixture> {
  const fixturePath = new URL("./fixtures/diego-fact-groups.json", import.meta.url);
  const parsed = JSON.parse(await readFile(fixturePath, "utf8")) as FactGroupFixture;
  if (parsed.schemaVersion !== 1 || parsed.case !== "diego") throw new Error("Invalid Diego fact-group fixture.");
  return parsed;
}

export async function readEvaluationSources(root: string, sources: CapturedSourceMetadata[]): Promise<EvaluationSource[]> {
  return Promise.all(sources.map(async (source) => {
    try {
      const content = await readFile(join(root, source.relativePath), "utf8");
      return { ...source, content };
    } catch {
      return { ...source };
    }
  }));
}
