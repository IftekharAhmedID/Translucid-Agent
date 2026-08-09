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
  "archives.search",
  "public_records.search",
  "scholarly.search",
  "packages.inspect",
  "security_records.search",
] as const;

export type ToolName = (typeof toolNames)[number];

const contextSchema = z.object({
  questionId: z.uuid(),
  claimIds: z.array(z.uuid()).max(100),
  publicRationale: z.string().trim().min(10).max(500),
});

const searchText = z.string().trim().min(2).max(1_000);
const httpUrl = z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol));

const schemas = {
  "web.search": contextSchema.extend({ query: searchText, mode: z.enum(["fast", "auto"]).default("fast") }),
  "web.fetch": contextSchema.extend({ url: httpUrl }),
  "professional.profile": contextSchema.extend({ username: z.string().trim().min(2).max(200), requiredMaterialField: z.string().trim().max(100).optional() }),
  "professional.activity": contextSchema.extend({ username: z.string().trim().min(2).max(200) }),
  "social.profile": contextSchema.extend({
    platform: z.enum(["X", "INSTAGRAM", "TIKTOK"]),
    handle: z.string().trim().min(1).max(200),
    reason: z.enum(["EXPLICIT_SOCIAL_CLAIM", "PUBLIC_IDENTITY_CROSS_LINK", "MATERIAL_ACTIVITY_QUESTION"]),
  }),
  "github.graphql": contextSchema.extend({ query: z.string().min(1).max(20_000), variables: z.record(z.string(), z.unknown()).default({}) }),
  "github.rest": contextSchema.extend({ path: z.string().regex(/^\/(users|repos|search|commits|issues|pulls|orgs)\b/).max(1_000) }),
  "archives.search": contextSchema.extend({ url: httpUrl, fromYear: z.number().int().min(1996).max(2100).optional(), toYear: z.number().int().min(1996).max(2100).optional() }),
  "public_records.search": contextSchema.extend({ recordType: z.enum(["PATENT", "SEC", "IETF"]), query: searchText }),
  "scholarly.search": contextSchema.extend({ query: searchText }),
  "packages.inspect": contextSchema.extend({ registry: z.enum(["NPM", "PYPI", "HUGGING_FACE"]), package: z.string().trim().min(1).max(300) }),
  "security_records.search": contextSchema.extend({ ecosystem: z.string().trim().max(100).optional(), package: z.string().trim().max(300).optional(), cve: z.string().regex(/^CVE-\d{4}-\d{4,}$/i).optional() }).refine((value) => Boolean(value.package || value.cve), "Package or CVE is required."),
} satisfies Record<ToolName, z.ZodType>;

export type ParsedToolRequest = {
  [Name in ToolName]: { tool: Name; arguments: z.infer<(typeof schemas)[Name]> }
}[ToolName];

export function parseToolRequest(input: unknown): ParsedToolRequest {
  const envelope = z.object({ tool: z.enum(toolNames), arguments: z.unknown() }).strict().parse(input);
  return {
    tool: envelope.tool,
    arguments: schemas[envelope.tool].parse(envelope.arguments),
  } as ParsedToolRequest;
}

export const toolCapabilities: Record<ToolName, Capability> = {
  "web.search": "WEB_SEARCH",
  "web.fetch": "WEB_SEARCH",
  "professional.profile": "LINKEDIN_PROFILE",
  "professional.activity": "LINKEDIN_ACTIVITY",
  "social.profile": "SOCIAL_PROFILE",
  "github.graphql": "GITHUB",
  "github.rest": "GITHUB",
  "archives.search": "ARCHIVES",
  "public_records.search": "PUBLIC_RECORDS",
  "scholarly.search": "SCHOLARLY",
  "packages.inspect": "PACKAGES",
  "security_records.search": "SECURITY_RECORDS",
};

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
  observedAt: string;
  costUsd: number;
};

export function unavailableResult(capability: Capability): ToolResult {
  if (!capabilityNames.includes(capability)) throw new Error("Unknown capability.");
  return { status: "CAPABILITY_UNAVAILABLE", capability, artifactIds: [], observedAt: new Date().toISOString(), costUsd: 0 };
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
