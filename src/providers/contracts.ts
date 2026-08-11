import { z } from "zod";

import { capabilityNames, type Capability } from "../core/capabilities.ts";

export const toolNames = [
  "web.search",
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
const httpUrl = z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol));
const webSearchSchema = contextSchema.extend({
  query: searchText,
  mode: z.enum(["fast", "auto"]).default("fast"),
  highlightQuery: searchText.optional(),
  resultLimit: z.number().int().min(1).max(10).default(5),
}).transform((value) => ({ ...value, highlightQuery: value.highlightQuery ?? value.query }));

const headlessSchemas = {
  "web.search": z.object({
    query: searchText,
    mode: z.enum(["fast", "auto"]).default("fast"),
    highlightQuery: searchText.optional(),
    resultLimit: z.number().int().min(1).max(10).default(5),
  }).strict().transform((value) => ({ ...value, highlightQuery: value.highlightQuery ?? value.query })),
  "web.fetch": z.object({ url: httpUrl }).strict(),
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
  "web.fetch": contextSchema.extend({ url: httpUrl }),
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
