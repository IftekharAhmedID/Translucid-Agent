import { z } from "zod";

import { capabilityNames, type Capability } from "../core/capabilities.ts";

export const toolNames = [
  "web.search",
  "web.search.batch",
  "web.fetch",
  "professional.profile",
  "professional.activity",
  "social.profile",
  "github.graphql",
  "github.rest",
  "github.clone",
  "archives.search",
  "public_records.search",
  "scholarly.search",
  "packages.inspect",
  "security_records.search",
] as const;

export type ToolName = (typeof toolNames)[number];
export const professionalMaterialFieldSchema = z.enum(["IDENTITY", "CURRENT_POSITION", "EMPLOYMENT_HISTORY", "EDUCATION"]);
export type ProfessionalMaterialField = z.infer<typeof professionalMaterialFieldSchema>;
export type ProviderCostSource = "REPORTED" | "CONFIGURED" | "FREE_PUBLIC" | "UNKNOWN";

const contextSchema = z.object({
  questionId: z.uuid(),
  claimIds: z.array(z.uuid()).max(100),
  publicRationale: z.string().trim().min(10).max(500),
});

const searchText = z.string().trim().min(2).max(1_000);
const deepFocusText = z.string().trim().min(2).max(600).refine((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value), "deepFocus must contain printable text.");
const httpUrl = z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol));
const sourceRef = z.string().regex(/^S[1-9]\d*$/);
const searchDomainPattern = /^(?:\*\.)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/;
const searchModeSchema = z.enum(["fast", "auto", "deep-lite", "deep", "deep-reasoning"]);
const searchCategorySchema = z.enum(["company", "people", "publication", "news", "personal site", "financial report"]);

function normalizeSearchDomains(values: string[]): string[] {
  return [...new Set(values.map((value) => {
    const slash = value.indexOf("/");
    return slash < 0 ? value.toLocaleLowerCase("en-US") : `${value.slice(0, slash).toLocaleLowerCase("en-US")}${value.slice(slash)}`;
  }))].sort();
}

const searchDomainsSchema = z.array(z.string().trim().min(1).max(500).regex(searchDomainPattern))
  .min(1)
  .max(10)
  .transform(normalizeSearchDomains);
const utcTimestampSchema = z.iso.datetime({ offset: true })
  .refine((value) => value.endsWith("Z") && !Number.isNaN(Date.parse(value)), "Expected an ISO-8601 UTC timestamp.")
  .refine((value) => {
    const date = new Date(value);
    return date.toISOString().slice(0, 10) === value.slice(0, 10);
  }, "Expected a valid UTC calendar date.")
  .transform((value) => new Date(value).toISOString());

type SearchRoute = {
  query: string;
  mode: z.infer<typeof searchModeSchema>;
  category?: z.infer<typeof searchCategorySchema>;
  additionalQueries?: string[];
  deepFocus?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  startPublishedDate?: string;
  endPublishedDate?: string;
  maxAgeHours?: number;
  livecrawlTimeout?: number;
};

type FetchRoute = {
  url?: string;
  discoveryRef?: string;
  subpages?: number;
  subpageTarget?: string[];
};

type BatchSearchRoute = Omit<SearchRoute, "mode" | "additionalQueries" | "deepFocus">;

function normalizedSearchQuery(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function domainsOverlap(left: string, right: string): boolean {
  const split = (value: string) => {
    const slash = value.indexOf("/");
    return { host: slash < 0 ? value : value.slice(0, slash), path: slash < 0 ? "" : value.slice(slash) };
  };
  const leftParts = split(left);
  const rightParts = split(right);
  const matches = (pattern: string, host: string) => pattern.startsWith("*.") ? host.endsWith(`.${pattern.slice(2)}`) : pattern === host;
  const hostsOverlap = matches(leftParts.host, rightParts.host) || matches(rightParts.host, leftParts.host);
  const pathsOverlap = !leftParts.path || !rightParts.path || leftParts.path === rightParts.path
    || leftParts.path.startsWith(`${rightParts.path}/`) || rightParts.path.startsWith(`${leftParts.path}/`);
  return hostsOverlap && pathsOverlap;
}

function searchRouteErrors(value: SearchRoute): Array<{ path: string[]; message: string }> {
  const errors: Array<{ path: string[]; message: string }> = [];
  if (value.additionalQueries && !["deep", "deep-reasoning"].includes(value.mode)) {
    errors.push({ path: ["additionalQueries"], message: "additionalQueries require deep or deep-reasoning mode." });
  }
  if (value.additionalQueries?.some((query) => normalizedSearchQuery(query) === normalizedSearchQuery(value.query))) {
    errors.push({ path: ["additionalQueries"], message: "additionalQueries cannot duplicate the primary query." });
  }
  if (value.additionalQueries) {
    const normalized = value.additionalQueries.map(normalizedSearchQuery);
    if (new Set(normalized).size !== normalized.length) errors.push({ path: ["additionalQueries"], message: "additionalQueries must be distinct." });
  }
  if (value.deepFocus && !["deep", "deep-reasoning"].includes(value.mode)) {
    errors.push({ path: ["deepFocus"], message: "deepFocus requires deep or deep-reasoning mode." });
  }
  if (value.category === "people" && (value.includeDomains || value.excludeDomains || value.startPublishedDate || value.endPublishedDate)) {
    errors.push({ path: ["category"], message: "People search does not accept domain or date filters." });
  }
  if (value.category === "company" && (value.includeDomains || value.excludeDomains || value.startPublishedDate || value.endPublishedDate)) {
    errors.push({ path: ["category"], message: "Company search does not accept domain or date filters." });
  }
  if (value.livecrawlTimeout !== undefined && (value.maxAgeHours === undefined || value.maxAgeHours < 0)) {
    errors.push({ path: ["livecrawlTimeout"], message: "livecrawlTimeout requires a non-negative maxAgeHours." });
  }
  if (value.includeDomains?.some((domain) => value.excludeDomains?.some((excluded) => domainsOverlap(domain, excluded)))) {
    errors.push({ path: ["excludeDomains"], message: "includeDomains and excludeDomains cannot overlap." });
  }
  if (value.startPublishedDate && value.endPublishedDate && value.startPublishedDate > value.endPublishedDate) {
    errors.push({ path: ["endPublishedDate"], message: "endPublishedDate must not precede startPublishedDate." });
  }
  return errors;
}

function validateSearchRoute(value: SearchRoute, context: { addIssue(issue: { code: "custom"; path: string[]; message: string }): void }): void {
  for (const issue of searchRouteErrors(value)) context.addIssue({ code: "custom", ...issue });
}

function validateFetchRoute(value: FetchRoute, context: { addIssue(issue: { code: "custom"; path: string[]; message: string }): void }): void {
  if ((value.url === undefined) === (value.discoveryRef === undefined)) {
    context.addIssue({ code: "custom", path: ["url"], message: "Exactly one of url or discoveryRef must be supplied." });
  }
  if ((value.subpages === undefined) !== (value.subpageTarget === undefined)) {
    context.addIssue({ code: "custom", path: [value.subpages === undefined ? "subpages" : "subpageTarget"], message: "subpages and subpageTarget must be supplied together." });
  }
}

const webSearchArguments = {
  query: searchText,
  mode: searchModeSchema.default("auto"),
  highlightQuery: searchText.optional(),
  resultLimit: z.number().int().min(1).max(10).default(10),
  category: searchCategorySchema.optional(),
  deepFocus: deepFocusText.optional(),
  includeDomains: searchDomainsSchema.optional(),
  additionalQueries: z.array(searchText).min(1).max(6).optional(),
  excludeDomains: searchDomainsSchema.optional(),
  startPublishedDate: utcTimestampSchema.optional(),
  endPublishedDate: utcTimestampSchema.optional(),
  maxAgeHours: z.number().int().min(-1).max(8_760).optional(),
  livecrawlTimeout: z.number().int().min(1_000).max(15_000).optional(),
};
const webSearchSchema = contextSchema.extend(webSearchArguments)
  .superRefine((value, context) => validateSearchRoute(value, context));
const batchSearchItemArguments = {
  query: searchText,
  highlightQuery: searchText.optional(),
  category: searchCategorySchema.optional(),
  includeDomains: searchDomainsSchema.optional(),
  excludeDomains: searchDomainsSchema.optional(),
  startPublishedDate: utcTimestampSchema.optional(),
  endPublishedDate: utcTimestampSchema.optional(),
  maxAgeHours: z.number().int().min(-1).max(8_760).optional(),
  livecrawlTimeout: z.number().int().min(1_000).max(15_000).optional(),
};
const batchSearchItemSchema = z.object(batchSearchItemArguments).strict()
  .superRefine((value, context) => validateSearchRoute({ ...value, mode: "auto" } satisfies BatchSearchRoute & { mode: "auto" }, context));
const batchSearchArguments = { searches: z.array(batchSearchItemSchema).min(2).max(6) };
const batchSearchSchema = z.object(batchSearchArguments).strict()
  .superRefine((value, context) => {
    const queries = value.searches.map((item) => normalizedSearchQuery(item.query));
    if (new Set(queries).size !== queries.length) context.addIssue({ code: "custom", path: ["searches"], message: "Batch search queries must be distinct." });
  });
const webFetchArguments = {
  url: httpUrl.optional(),
  discoveryRef: sourceRef.optional(),
  focus: searchText.optional(),
  subpages: z.number().int().min(1).max(10).optional(),
  subpageTarget: z.array(searchText).min(1).max(10).optional(),
};
const webFetchSchema = contextSchema.extend(webFetchArguments).superRefine((value, context) => validateFetchRoute(value, context));

const headlessSchemas = {
  "web.search": z.object(webSearchArguments).strict()
    .superRefine((value, context) => validateSearchRoute(value, context)),
  "web.search.batch": batchSearchSchema,
  "web.fetch": z.object(webFetchArguments).strict().superRefine((value, context) => validateFetchRoute(value, context)),
  "professional.profile": z.object({ username: z.string().trim().min(2).max(200), requiredMaterialField: professionalMaterialFieldSchema.default("IDENTITY") }).strict(),
  "professional.activity": z.object({ username: z.string().trim().min(2).max(200) }).strict(),
  "social.profile": z.object({
    platform: z.enum(["X", "INSTAGRAM", "TIKTOK"]),
    handle: z.string().trim().min(1).max(200),
    reason: z.enum(["EXPLICIT_SOCIAL_CLAIM", "PUBLIC_IDENTITY_CROSS_LINK", "MATERIAL_ACTIVITY_QUESTION"]),
  }).strict(),
  "github.graphql": z.object({ query: z.string().min(1).max(20_000), variables: z.record(z.string(), z.unknown()).default({}) }).strict(),
  "github.rest": z.object({ path: z.string().regex(/^\/(users|repos|search|commits|issues|pulls|orgs)\b/).max(1_000) }).strict(),
  "github.clone": z.object({
    repository: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,99})\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/),
    ref: z.string().regex(/^(?![-/])(?!.*\.\.)(?!.*\/\.)(?!.*\.lock(?:\/|$))[A-Za-z0-9._/-]{1,200}$/).optional(),
    authorHint: z.string().trim().min(1).max(200).optional(),
  }).strict(),
  "archives.search": z.object({ url: httpUrl, fromYear: z.number().int().min(1996).max(2100).optional(), toYear: z.number().int().min(1996).max(2100).optional() }).strict(),
  "public_records.search": z.object({ recordType: z.enum(["PATENT", "SEC", "IETF"]), query: searchText }).strict(),
  "scholarly.search": z.object({ query: searchText }).strict(),
  "packages.inspect": z.object({ registry: z.enum(["NPM", "PYPI", "HUGGING_FACE"]), package: z.string().trim().min(1).max(300) }).strict(),
  "security_records.search": z.object({ ecosystem: z.string().trim().max(100).optional(), package: z.string().trim().max(300).optional(), cve: z.string().regex(/^CVE-\d{4}-\d{4,}$/i).optional() }).strict().refine((value) => Boolean(value.package || value.cve), "Package or CVE is required."),
} satisfies Record<ToolName, z.ZodType>;

const schemas = {
  "web.search": webSearchSchema,
  "web.search.batch": contextSchema.extend(batchSearchArguments).superRefine((value, context) => {
    const queries = value.searches.map((item) => normalizedSearchQuery(item.query));
    if (new Set(queries).size !== queries.length) context.addIssue({ code: "custom", path: ["searches"], message: "Batch search queries must be distinct." });
  }),
  "web.fetch": webFetchSchema,
  "professional.profile": contextSchema.extend({ username: z.string().trim().min(2).max(200), requiredMaterialField: professionalMaterialFieldSchema.default("IDENTITY") }),
  "professional.activity": contextSchema.extend({ username: z.string().trim().min(2).max(200) }),
  "social.profile": contextSchema.extend({
    platform: z.enum(["X", "INSTAGRAM", "TIKTOK"]),
    handle: z.string().trim().min(1).max(200),
    reason: z.enum(["EXPLICIT_SOCIAL_CLAIM", "PUBLIC_IDENTITY_CROSS_LINK", "MATERIAL_ACTIVITY_QUESTION"]),
  }),
  "github.graphql": contextSchema.extend({ query: z.string().min(1).max(20_000), variables: z.record(z.string(), z.unknown()).default({}) }),
  "github.rest": contextSchema.extend({ path: z.string().regex(/^\/(users|repos|search|commits|issues|pulls|orgs)\b/).max(1_000) }),
  "github.clone": contextSchema.extend({
    repository: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,99})\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/),
    ref: z.string().regex(/^(?![-/])(?!.*\.\.)(?!.*\/\.)(?!.*\.lock(?:\/|$))[A-Za-z0-9._/-]{1,200}$/).optional(),
    authorHint: z.string().trim().min(1).max(200).optional(),
  }),
  "archives.search": contextSchema.extend({ url: httpUrl, fromYear: z.number().int().min(1996).max(2100).optional(), toYear: z.number().int().min(1996).max(2100).optional() }),
  "public_records.search": contextSchema.extend({ recordType: z.enum(["PATENT", "SEC", "IETF"]), query: searchText }),
  "scholarly.search": contextSchema.extend({ query: searchText }),
  "packages.inspect": contextSchema.extend({ registry: z.enum(["NPM", "PYPI", "HUGGING_FACE"]), package: z.string().trim().min(1).max(300) }),
  "security_records.search": contextSchema.extend({ ecosystem: z.string().trim().max(100).optional(), package: z.string().trim().max(300).optional(), cve: z.string().regex(/^CVE-\d{4}-\d{4,}$/i).optional() }).refine((value) => Boolean(value.package || value.cve), "Package or CVE is required."),
} satisfies Record<ToolName, z.ZodType>;

export type ParsedToolRequest = {
  [Name in ToolName]: { tool: Name; arguments: z.infer<(typeof schemas)[Name]> }
}[ToolName];

export type HeadlessParsedToolRequest = {
  [Name in ToolName]: { tool: Name; arguments: z.infer<(typeof headlessSchemas)[Name]> }
}[ToolName];

export function parseToolRequest(input: unknown): ParsedToolRequest {
  const envelope = z.object({ tool: z.enum(toolNames), arguments: z.unknown() }).strict().parse(input);
  return {
    tool: envelope.tool,
    arguments: schemas[envelope.tool].parse(envelope.arguments),
  } as ParsedToolRequest;
}

export function parseHeadlessToolRequest(input: unknown): HeadlessParsedToolRequest {
  const envelope = z.object({ tool: z.enum(toolNames), arguments: z.unknown() }).strict().parse(input);
  return {
    tool: envelope.tool,
    arguments: headlessSchemas[envelope.tool].parse(envelope.arguments),
  } as HeadlessParsedToolRequest;
}

export const toolCapabilities: Record<ToolName, Capability> = {
  "web.search": "WEB_SEARCH",
  "web.search.batch": "WEB_SEARCH",
  "web.fetch": "WEB_SEARCH",
  "professional.profile": "LINKEDIN_PROFILE",
  "professional.activity": "LINKEDIN_ACTIVITY",
  "social.profile": "SOCIAL_PROFILE",
  "github.graphql": "GITHUB",
  "github.rest": "GITHUB",
  "github.clone": "GITHUB",
  "archives.search": "ARCHIVES",
  "public_records.search": "PUBLIC_RECORDS",
  "scholarly.search": "SCHOLARLY",
  "packages.inspect": "PACKAGES",
  "security_records.search": "SECURITY_RECORDS",
};

export function capabilityForRequest(request: ParsedToolRequest | HeadlessParsedToolRequest): Capability {
  if (request.tool === "public_records.search" && request.arguments.recordType === "PATENT") return "PATENTS";
  return toolCapabilities[request.tool];
}

export const toolResultStatusSchema = z.enum([
  "OK",
  "CAPABILITY_UNAVAILABLE",
  "RATE_LIMITED",
  "BUDGET_EXHAUSTED",
  "ERROR",
]);

export type ToolResult<T = unknown> = {
  status: z.infer<typeof toolResultStatusSchema>;
  capability: Capability;
  provider?: string;
  data?: T;
  artifactIds: string[];
  evidenceEligibleArtifactIds: string[];
  artifactRefs?: Array<{ ref: string; kind: string; sourceUrl?: string }>;
  observedAt: string;
  costUsd: number;
  costSource: ProviderCostSource;
};

export function unavailableResult(capability: Capability): ToolResult {
  if (!capabilityNames.includes(capability)) throw new Error("Unknown capability.");
  return { status: "CAPABILITY_UNAVAILABLE", capability, artifactIds: [], evidenceEligibleArtifactIds: [], observedAt: new Date().toISOString(), costUsd: 0, costSource: "UNKNOWN" };
}

export function decideProfessionalProfileRoute(input: {
  linkdAttempted: boolean;
  linkdValid: boolean;
  requiredMaterialFieldPresent: boolean;
  brightAttempted: boolean;
}): "LINKDAPI" | "BRIGHTDATA_ONCE" | "STOP_SATISFIED" | "STOP_UNRESOLVED" {
  if (!input.linkdAttempted) return "LINKDAPI";
  if (input.linkdValid && input.requiredMaterialFieldPresent) return "STOP_SATISFIED";
  if (!input.brightAttempted) return "BRIGHTDATA_ONCE";
  return "STOP_UNRESOLVED";
}

export function shouldAllowSocialResearch(reason: string): boolean {
  return ["EXPLICIT_SOCIAL_CLAIM", "PUBLIC_IDENTITY_CROSS_LINK", "MATERIAL_ACTIVITY_QUESTION"].includes(reason);
}
