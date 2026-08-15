import { buildCapabilityRegistry, type Capability } from "../core/capabilities.ts";
import {
  capabilityForRequest,
  parseHeadlessToolRequest,
  shouldAllowSocialResearch,
  type HeadlessParsedToolRequest,
  type ProfessionalMaterialField,
  type ProviderCostSource,
  type ToolName,
  type ToolResult,
  unavailableResult,
} from "./contracts.ts";
import type {
  ConcreteProviderResult,
  ProviderArtifactInput,
  ProviderCallBackend,
  ProviderExecutionContext,
  ProviderNetworkResult,
} from "./backend.ts";
import { inspectGitHubRepository } from "./github-repository.ts";
import { safePublicFetch } from "./http.ts";
import { fetchWithRetry } from "./retry.ts";

type Environment = Record<string, string | undefined>;
type AnyParsedToolRequest = HeadlessParsedToolRequest;
type RequestOf<Name extends ToolName> = Extract<AnyParsedToolRequest, { tool: Name }>;
type ProfileRequest = Extract<AnyParsedToolRequest, { tool: "professional.profile" }>;
type ActivityRequest = Extract<AnyParsedToolRequest, { tool: "professional.activity" }>;

export type HeadlessToolResult = {
  status: "OK" | "CAPABILITY_UNAVAILABLE" | "RATE_LIMITED" | "BUDGET_EXHAUSTED" | "ERROR";
  capability: Capability;
  provider?: string;
  sourceRefs: string[];
  evidenceEligibleSourceRefs: string[];
  preview: string;
  observedAt: string;
  costUsd: number;
  costSource: ProviderCostSource;
  cache: "HIT" | "MISS";
};

const defaultToolCeilings: Record<ToolName, number> = {
  "web.search": 1_000,
  "web.fetch": 2_000,
  "professional.profile": 20,
  "professional.activity": 10,
  "social.profile": 10,
  "github.graphql": 200,
  "github.rest": 400,
  "github.clone": 3,
  "archives.search": 100,
  "public_records.search": 100,
  "scholarly.search": 100,
  "packages.inspect": 100,
  "security_records.search": 100,
};

const ceilingEnvironmentKeys: Record<ToolName, string> = {
  "web.search": "WEB_SEARCH_CEILING",
  "web.fetch": "WEB_FETCH_CEILING",
  "professional.profile": "PROFESSIONAL_PROFILE_CEILING",
  "professional.activity": "PROFESSIONAL_ACTIVITY_CEILING",
  "social.profile": "SOCIAL_PROFILE_CEILING",
  "github.graphql": "GITHUB_GRAPHQL_CEILING",
  "github.rest": "GITHUB_REST_CEILING",
  "github.clone": "GITHUB_CLONE_CEILING",
  "archives.search": "ARCHIVES_CEILING",
  "public_records.search": "PUBLIC_RECORDS_CEILING",
  "scholarly.search": "SCHOLARLY_CEILING",
  "packages.inspect": "PACKAGES_CEILING",
  "security_records.search": "SECURITY_RECORDS_CEILING",
};

export function agentToolCeiling(agent: string, tool: ToolName): undefined {
  void agent;
  void tool;
  return undefined;
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async use<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try { return await work(); }
    finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

function concurrencyFor(tool: ToolName, environment: Environment): number {
  const key = tool.startsWith("web.") ? "EXA_CONCURRENCY"
    : tool.startsWith("professional.") ? "LINKDAPI_CONCURRENCY"
    : tool.startsWith("social.") ? "BRIGHTDATA_CONCURRENCY"
    : tool.startsWith("github.") ? "GITHUB_CONCURRENCY"
    : tool.startsWith("archives.") ? "ARCHIVES_CONCURRENCY"
    : tool.startsWith("public_records.") ? "PUBLIC_RECORDS_CONCURRENCY"
    : tool.startsWith("scholarly.") ? "SCHOLARLY_CONCURRENCY"
    : tool.startsWith("packages.") ? "PACKAGES_CONCURRENCY"
    : "SECURITY_RECORDS_CONCURRENCY";
  const parsed = Number(environment[key] ?? 3);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (Buffer.byteLength(text) > 5 * 1024 * 1024) throw new Error("Provider response exceeds capture limit.");
  if (!response.ok) {
    const error = new Error(`Provider returned HTTP ${response.status}.`);
    Object.assign(error, { status: response.status, retryAfter: response.headers.get("retry-after") });
    throw error;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json")) {
    try { return JSON.parse(text) as unknown; }
    catch { return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown); }
  }
  return { text };
}

async function apiFetch(url: string, init: RequestInit, onAttempt?: (attempt: number) => void): Promise<unknown> {
  return readResponse(await fetchWithRetry(url, init, 3, onAttempt));
}

function authHeaders(value: string | undefined, scheme = "Bearer"): Record<string, string> {
  return value ? { authorization: `${scheme} ${value}` } : {};
}

function fixtureData(request: AnyParsedToolRequest): unknown {
  const common = request.arguments as { questionId?: string; claimIds?: string[] };
  return {
    synthetic: true,
    tool: request.tool,
    ...(common.questionId ? { questionId: common.questionId } : {}),
    ...(common.claimIds ? { claimIds: common.claimIds } : {}),
    records: request.tool === "professional.profile"
      ? [{ fullName: "Synthetic Candidate", headline: "Principal Engineer", positions: [{ company: "Acme Synthetic Labs", title: "Principal Engineer", start: "2021", end: "2025" }] }]
      : [{ title: "Synthetic fixture result", url: "https://example.test/synthetic-source", text: "Synthetic Candidate held the title Principal Engineer at Acme Synthetic Labs from 2021 through 2025. Synthetic corroborating content for deterministic development tests." }],
  };
}

function preview(value: unknown): string {
  let serialized: string;
  try { serialized = typeof value === "string" ? value : JSON.stringify(value); }
  catch { serialized = "Provider returned a non-serializable response."; }
  return serialized.length <= 20_000 ? serialized : `${serialized.slice(0, 20_000)}\n[preview truncated; use source.excerpts]`;
}

export function unwrapLinkdProfileResponse(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const envelope = value as Record<string, unknown>;
  if (envelope.success === false) return undefined;
  const candidate = envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data)
    ? envelope.data as Record<string, unknown>
    : envelope;
  return Object.keys(candidate).length > 0 ? candidate : undefined;
}

function nonEmpty(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value && typeof value === "object" && Object.keys(value as Record<string, unknown>).length > 0);
}

export function profileHasMaterialField(profile: Record<string, unknown>, field: ProfessionalMaterialField): boolean {
  if (field === "IDENTITY") return [profile.fullName, profile.name, profile.username, profile.publicIdentifier].some(nonEmpty);
  if (field === "CURRENT_POSITION") return [profile.currentPositions, profile.currentPosition, profile.position, profile.headline].some(nonEmpty);
  if (field === "EMPLOYMENT_HISTORY") return [profile.fullPositions, profile.positions, profile.experience].some(nonEmpty);
  return [profile.educations, profile.education].some(nonEmpty);
}

export function socialProfileUrl(platform: "X" | "INSTAGRAM" | "TIKTOK", rawHandle: string): string {
  let handle = rawHandle.trim();
  try {
    const parsed = new URL(handle);
    const segments = parsed.pathname.split("/").filter(Boolean);
    handle = segments[0] ?? "";
  } catch { /* a bare handle is the normal input */ }
  handle = handle.replace(/^@/, "");
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(handle)) throw new Error("Social profile handle is invalid.");
  if (platform === "X") return `https://x.com/${handle}`;
  if (platform === "INSTAGRAM") return `https://www.instagram.com/${handle}/`;
  return `https://www.tiktok.com/@${handle}`;
}

export class ProviderExecutor {
  private readonly registry;
  private readonly pools: Map<ToolName, Semaphore>;
  private readonly brightDataPool: Semaphore;

  constructor(private readonly environment: Environment = process.env, private readonly callBackend: ProviderCallBackend) {
    this.registry = buildCapabilityRegistry(environment);
    this.pools = new Map(Object.keys(defaultToolCeilings).map((tool) => [tool as ToolName, new Semaphore(concurrencyFor(tool as ToolName, environment))]));
    this.brightDataPool = new Semaphore(Math.max(1, Number(environment.BRIGHTDATA_CONCURRENCY ?? 2)));
  }

  get capabilityRegistry() {
    return this.registry;
  }

  async executeHeadless(raw: unknown, context: ProviderExecutionContext): Promise<HeadlessToolResult> {
    const request = parseHeadlessToolRequest(raw);
    const result = await this.executeParsed(request, context);
    return {
      status: result.status,
      capability: result.capability,
      ...(result.provider ? { provider: result.provider } : {}),
      sourceRefs: result.artifactIds,
      evidenceEligibleSourceRefs: result.evidenceEligibleArtifactIds,
      preview: preview(result.data),
      observedAt: result.observedAt,
      costUsd: result.costUsd,
      costSource: result.costSource,
      cache: result.cache ?? "MISS",
    };
  }

  private async executeParsed(request: AnyParsedToolRequest, context: ProviderExecutionContext): Promise<ToolResult & { cache?: "HIT" | "MISS" }> {
    const capability = capabilityForRequest(request);
    const entry = this.registry[capability];
    if (!["READY", "READY_FIXTURE", "DEGRADED"].includes(entry.state)) return unavailableResult(capability);
    if (request.tool === "social.profile" && !shouldAllowSocialResearch(request.arguments.reason)) return unavailableResult(capability);
    const pool = this.pools.get(request.tool);
    if (!pool) throw new Error("Provider semaphore is missing.");
    try {
      const response = await pool.use(() => this.environment.PROVIDER_MODE === "live"
        ? this.executeLive(request, context, capability)
        : this.executeFixture(request, context, capability));
      return {
        status: "OK",
        capability,
        provider: response.provider,
        data: response.data,
        artifactIds: response.artifactIds,
        evidenceEligibleArtifactIds: response.evidenceEligibleArtifactIds,
        observedAt: new Date().toISOString(),
        costUsd: response.costUsd,
        costSource: response.costSource,
        cache: response.reused ? "HIT" : "MISS",
      };
    } catch (error) {
      const responseStatus = typeof (error as { status?: unknown })?.status === "number" ? Number((error as { status: number }).status) : undefined;
      const status = error instanceof Error && error.message.startsWith("Budget exhausted") ? "BUDGET_EXHAUSTED"
        : responseStatus === 429 ? "RATE_LIMITED" : "ERROR";
      return {
        status,
        capability,
        provider: "gateway",
        data: { message: error instanceof Error ? error.message : "Provider request failed." },
        artifactIds: [],
        evidenceEligibleArtifactIds: [],
        observedAt: new Date().toISOString(),
        costUsd: 0,
        costSource: "UNKNOWN",
      };
    }
  }

  private executeFixture(request: AnyParsedToolRequest, context: ProviderExecutionContext, capability: Capability): Promise<ConcreteProviderResult> {
    return this.call(request, context, capability, "fixture", `fixture.${request.tool}`, request.arguments, async () => ({
      data: fixtureData(request),
      sourceUrl: `https://example.test/fixtures/${request.tool}`,
      costUsd: 0,
      costSource: "FREE_PUBLIC",
    }));
  }

  private async executeLive(request: AnyParsedToolRequest, context: ProviderExecutionContext, capability: Capability): Promise<ConcreteProviderResult> {
    switch (request.tool) {
      case "web.search": return this.webSearch(request, context, capability);
      case "web.fetch": return this.webFetch(request, context, capability);
      case "professional.profile": return this.professionalProfile(request, context, capability);
      case "professional.activity": return this.professionalActivity(request, context, capability);
      case "social.profile": {
        const datasetKey = `BRIGHTDATA_${request.arguments.platform}_PROFILE_DATASET_ID`;
        return this.brightData(request, context, capability, this.required(datasetKey), { url: socialProfileUrl(request.arguments.platform, request.arguments.handle) }, `brightdata.${request.arguments.platform.toLowerCase()}-profile`, `brightdata-${request.arguments.platform.toLowerCase()}`);
      }
      case "github.graphql": return this.call(request, context, capability, "github", "github.graphql", { query: request.arguments.query, variables: request.arguments.variables }, async (signal, onAttempt) => ({
        data: await apiFetch("https://api.github.com/graphql", { method: "POST", headers: { ...authHeaders(this.required("GITHUB_TOKEN")), "content-type": "application/json", "user-agent": this.publicUserAgent() }, body: JSON.stringify({ query: request.arguments.query, variables: request.arguments.variables }), signal }, onAttempt),
        sourceUrl: "https://api.github.com/graphql", costUsd: 0, costSource: "FREE_PUBLIC",
      }));
      case "github.rest": {
        const url = `https://api.github.com${request.arguments.path}`;
        return this.call(request, context, capability, "github", "github.rest", { path: request.arguments.path }, async (signal, onAttempt) => ({
          data: await apiFetch(url, { headers: { ...authHeaders(this.required("GITHUB_TOKEN")), accept: "application/vnd.github+json", "user-agent": this.publicUserAgent() }, signal }, onAttempt),
          sourceUrl: url, costUsd: 0, costSource: "FREE_PUBLIC",
        }));
      }
      case "github.clone": return this.call(request, context, capability, "github-public-clone", "github.clone", { repository: request.arguments.repository, ref: request.arguments.ref, authorHint: request.arguments.authorHint }, async (signal) => ({
        data: await inspectGitHubRepository({ repository: request.arguments.repository, ref: request.arguments.ref, authorHint: request.arguments.authorHint, signal }),
        sourceUrl: `https://github.com/${request.arguments.repository}`, costUsd: 0, costSource: "FREE_PUBLIC",
      }));
      case "archives.search": return this.archives(request, context, capability);
      case "public_records.search": return this.publicRecords(request, context, capability);
      case "scholarly.search": return this.scholarly(request, context, capability);
      case "packages.inspect": return this.packages(request, context, capability);
      case "security_records.search": return this.securityRecords(request, context, capability);
    }
  }

  private webSearch(request: RequestOf<"web.search">, context: ProviderExecutionContext, capability: Capability): Promise<ConcreteProviderResult> {
    const body = {
      query: request.arguments.query,
      type: request.arguments.mode,
      numResults: request.arguments.resultLimit,
      contents: {
        highlights: { query: request.arguments.highlightQuery, maxCharacters: 4_000 },
      },
    };
    return this.call(request, context, capability, "exa", "exa.search", body, async (signal, onAttempt) => {
      const data = await apiFetch("https://api.exa.ai/search", { method: "POST", headers: { "content-type": "application/json", "x-api-key": this.required("EXA_API_KEY") }, body: JSON.stringify(body), signal }, onAttempt);
      const envelope = data && typeof data === "object" ? data as Record<string, unknown> : {};
      const results = Array.isArray(envelope.results) ? envelope.results : [];
      const artifacts: ProviderArtifactInput[] = [{ kind: "SEARCH_DISCOVERY", sourceUrl: "https://api.exa.ai/search", content: data }];
      for (const candidate of results) {
        if (!candidate || typeof candidate !== "object") continue;
        const result = candidate as Record<string, unknown>;
        if (typeof result.url !== "string" || (!nonEmpty(result.text) && !nonEmpty(result.highlights))) continue;
        artifacts.push({
          kind: "SOURCE_CONTENT",
          sourceUrl: result.url,
          content: { title: result.title, url: result.url, highlights: result.highlights, publishedDate: result.publishedDate, author: result.author },
          provenance: { captureMethod: "EXA_INLINE_CONTENTS" },
        });
      }
      return { data, sourceUrl: "https://api.exa.ai/search", ...this.exaCost(data), artifacts };
    });
  }

  private webFetch(request: RequestOf<"web.fetch">, context: ProviderExecutionContext, capability: Capability): Promise<ConcreteProviderResult> {
    const url = request.arguments.url;
    if (this.environment.EXA_API_KEY) {
      return this.call(request, context, capability, "exa", "exa.contents", { urls: [url], text: true, highlights: true }, async (signal, onAttempt) => {
        const data = await apiFetch("https://api.exa.ai/contents", { method: "POST", headers: { "content-type": "application/json", "x-api-key": this.environment.EXA_API_KEY! }, body: JSON.stringify({ urls: [url], text: true, highlights: true }), signal }, onAttempt);
        return { data, sourceUrl: url, ...this.exaCost(data), artifacts: [{ kind: "SOURCE_CONTENT", sourceUrl: url, content: data, provenance: { captureMethod: "EXA_CONTENTS" } }] };
      });
    }
    return this.call(request, context, capability, "public-fetch", "public-fetch", { url }, async (signal) => {
      const response = await safePublicFetch(url, { headers: { "user-agent": this.publicUserAgent() }, signal });
      const data = await readResponse(response);
      return { data, sourceUrl: url, status: response.status, costUsd: 0, costSource: "FREE_PUBLIC", artifacts: [{ kind: "SOURCE_CONTENT", sourceUrl: url, content: data, status: response.status }] };
    });
  }

  private async professionalProfile(request: ProfileRequest, context: ProviderExecutionContext, capability: Capability): Promise<ConcreteProviderResult> {
    const username = request.arguments.username.trim().toLocaleLowerCase("en-US");
    let linkd: ConcreteProviderResult | undefined;
    let linkdError: string | undefined;
    if (this.environment.LINKDAPI_API_KEY) {
      try {
        const url = `https://linkdapi.com/api/v1/profile/full?username=${encodeURIComponent(username)}`;
        const knownCost = this.configuredCost("LINKDAPI_COST_USD_PER_CALL");
        linkd = await this.call(request, context, capability, "linkdapi", "linkdapi.profile", { username }, async (signal, onAttempt) => ({
          data: await apiFetch(url, { headers: { "X-linkdapi-apikey": this.environment.LINKDAPI_API_KEY! }, signal }, onAttempt),
          sourceUrl: `https://www.linkedin.com/in/${encodeURIComponent(username)}`,
          ...knownCost,
        }), knownCost);
        const profile = unwrapLinkdProfileResponse(linkd.data);
        if (profile && profileHasMaterialField(profile, request.arguments.requiredMaterialField)) return { ...linkd, data: profile };
      } catch (error) {
        linkdError = error instanceof Error ? error.message : "LinkdAPI request failed.";
      }
    }
    const limitation = `The ${request.arguments.requiredMaterialField.toLowerCase().replaceAll("_", " ")} field was not available from the configured professional-profile routes.`;
    const dataset = this.environment.BRIGHTDATA_LINKEDIN_PROFILE_DATASET_ID;
    if (!dataset) {
      if (!linkd) throw new Error(linkdError ?? `${limitation} Bright Data is not configured.`);
      return { ...linkd, data: { profile: unwrapLinkdProfileResponse(linkd.data), requiredMaterialField: request.arguments.requiredMaterialField, materialFieldPresent: false, limitation } };
    }
    try {
      const bright = await this.brightData(request, context, capability, dataset, { url: `https://www.linkedin.com/in/${username}` }, "brightdata.linkedin-profile", "brightdata-linkedin-profile");
      const brightProfile = this.firstRecord(bright.data);
      const present = brightProfile ? profileHasMaterialField(brightProfile, request.arguments.requiredMaterialField) : false;
      return this.combine([...(linkd ? [linkd] : []), bright], {
        linkdapi: linkd ? unwrapLinkdProfileResponse(linkd.data) : null,
        brightData: bright.data,
        requiredMaterialField: request.arguments.requiredMaterialField,
        materialFieldPresent: present,
        ...(present ? {} : { limitation }),
        ...(linkdError ? { linkdapiLimitation: linkdError } : {}),
      });
    } catch (error) {
      if (!linkd) throw error;
      return { ...linkd, data: { profile: unwrapLinkdProfileResponse(linkd.data), requiredMaterialField: request.arguments.requiredMaterialField, materialFieldPresent: false, limitation: `${limitation} Bright Data failed: ${error instanceof Error ? error.message : "unknown error"}` } };
    }
  }

  private async professionalActivity(request: ActivityRequest, context: ProviderExecutionContext, capability: Capability): Promise<ConcreteProviderResult> {
    const username = request.arguments.username.trim().toLocaleLowerCase("en-US");
    if (this.environment.LINKDAPI_API_KEY) {
      try {
        const url = `https://linkdapi.com/api/v1/profile/posts?username=${encodeURIComponent(username)}`;
        const knownCost = this.configuredCost("LINKDAPI_COST_USD_PER_CALL");
        return await this.call(request, context, capability, "linkdapi", "linkdapi.activity", { username }, async (signal, onAttempt) => ({
          data: await apiFetch(url, { headers: { "X-linkdapi-apikey": this.environment.LINKDAPI_API_KEY! }, signal }, onAttempt),
          sourceUrl: `https://www.linkedin.com/in/${encodeURIComponent(username)}/recent-activity/all/`,
          ...knownCost,
        }), knownCost);
      } catch { /* the single configured fallback is handled below */ }
    }
    return this.brightData(request, context, capability, this.required("BRIGHTDATA_LINKEDIN_POSTS_DATASET_ID"), { url: `https://www.linkedin.com/in/${username}/recent-activity/all/` }, "brightdata.linkedin-posts", "brightdata-linkedin-posts");
  }

  private async brightData(request: AnyParsedToolRequest, context: ProviderExecutionContext, capability: Capability, datasetId: string, payload: Record<string, unknown>, providerRoute: string, provider: string): Promise<ConcreteProviderResult> {
    const knownCost = this.configuredCost("BRIGHTDATA_COST_USD_PER_RECORD");
    return this.brightDataPool.use(() => this.call(request, context, capability, provider, providerRoute, { datasetId, ...payload }, async (signal, onAttempt) => {
      const url = `https://api.brightdata.com/datasets/v3/scrape?dataset_id=${encodeURIComponent(datasetId)}&format=json`;
      const data = await apiFetch(url, { method: "POST", headers: { ...authHeaders(this.required("BRIGHTDATA_API_KEY")), "content-type": "application/json" }, body: JSON.stringify([payload]), signal }, onAttempt);
      return { data, sourceUrl: String(payload.url ?? "https://api.brightdata.com/datasets/v3/scrape"), ...this.configuredCost("BRIGHTDATA_COST_USD_PER_RECORD", Array.isArray(data) ? Math.max(1, data.length) : 1) };
    }, knownCost));
  }

  private async archives(request: RequestOf<"archives.search">, context: ProviderExecutionContext, capability: Capability): Promise<ConcreteProviderResult> {
    const { url, fromYear, toYear } = request.arguments;
    const target = encodeURIComponent(url);
    const waybackUrl = `https://web.archive.org/cdx/search/cdx?url=${target}&output=json&filter=statuscode:200&filter=mimetype:text/html&collapse=digest&fl=timestamp,original,statuscode,mimetype,digest&limit=50${fromYear ? `&from=${fromYear}` : ""}${toYear ? `&to=${toYear}` : ""}`;
    try {
      const wayback = await this.publicApiCall(request, context, capability, "wayback", "wayback.cdx", { url, fromYear, toYear }, waybackUrl);
      if (!Array.isArray(wayback.data)) return wayback;
      if (wayback.data.length > 1) {
        const capture = wayback.data.at(-1);
        const timestamp = Array.isArray(capture) ? String(capture[0] ?? "") : "";
        const original = Array.isArray(capture) ? String(capture[1] ?? "") : "";
        if (/^\d{14}$/.test(timestamp) && /^https?:\/\//.test(original)) {
          const snapshotUrl = `https://web.archive.org/web/${timestamp}id_/${original}`;
          try {
            const snapshot = await this.publicApiCall(request, context, capability, "wayback", "wayback.capture", { timestamp, url: original }, snapshotUrl);
            return this.combine([wayback, snapshot], { captures: wayback.data, retrievedCapture: { timestamp, original, snapshotUrl, content: snapshot.data } });
          } catch { return { ...wayback, data: { captures: wayback.data, retrievedCapture: null } }; }
        }
        return { ...wayback, data: { captures: wayback.data, retrievedCapture: null } };
      }
    } catch { /* Common Crawl is the explicit fallback */ }

    const indexListUrl = "https://index.commoncrawl.org/collinfo.json";
    const indexList = await this.publicApiCall(request, context, capability, "common-crawl", "common-crawl.index-list", {}, indexListUrl);
    const currentIndex = Array.isArray(indexList.data) && indexList.data[0] && typeof indexList.data[0] === "object" ? String((indexList.data[0] as { id?: unknown }).id ?? "") : "";
    if (!/^CC-MAIN-\d{4}-\d{2}$/.test(currentIndex)) throw new Error("Common Crawl did not publish a valid current index.");
    const searchUrl = `https://index.commoncrawl.org/${currentIndex}-index?url=${target}&output=json&filter=status:200&filter=mime:text/html`;
    const search = await this.publicApiCall(request, context, capability, "common-crawl", "common-crawl.search", { index: currentIndex, url }, searchUrl);
    return this.combine([indexList, search], { index: currentIndex, captures: search.data });
  }

  private publicRecords(request: RequestOf<"public_records.search">, context: ProviderExecutionContext, capability: Capability): Promise<ConcreteProviderResult> {
    const query = encodeURIComponent(request.arguments.query);
    if (request.arguments.recordType === "PATENT") {
      const url = `https://api.uspto.gov/api/v1/patent/applications/search?q=${query}`;
      return this.publicApiCall(request, context, capability, "uspto-odp", "public-records.uspto", { query: request.arguments.query }, url, { "x-api-key": this.required("USPTO_API_KEY") });
    }
    if (request.arguments.recordType === "SEC") {
      const url = `https://efts.sec.gov/LATEST/search-index?q=${query}&from=0&size=20`;
      return this.publicApiCall(request, context, capability, "sec-edgar", "public-records.sec", { query: request.arguments.query }, url);
    }
    const url = `https://datatracker.ietf.org/api/v1/doc/document/?name__icontains=${query}&limit=20&format=json`;
    return this.publicApiCall(request, context, capability, "ietf-datatracker", "public-records.ietf", { query: request.arguments.query }, url);
  }

  private scholarly(request: RequestOf<"scholarly.search">, context: ProviderExecutionContext, capability: Capability): Promise<ConcreteProviderResult> {
    const query = encodeURIComponent(request.arguments.query);
    if (this.environment.OPENALEX_API_KEY) {
      const privateUrl = `https://api.openalex.org/works?search=${query}&per-page=20&api_key=${encodeURIComponent(this.environment.OPENALEX_API_KEY)}`;
      const publicUrl = `https://api.openalex.org/works?search=${query}&per-page=20`;
      return this.call(request, context, capability, "openalex", "scholarly.openalex", { query: request.arguments.query }, async (signal, onAttempt) => ({ data: await apiFetch(privateUrl, { headers: { "user-agent": this.publicUserAgent() }, signal }, onAttempt), sourceUrl: publicUrl, costUsd: 0, costSource: "FREE_PUBLIC" }));
    }
    const url = `https://api.crossref.org/works?query=${query}&rows=20&mailto=${encodeURIComponent(this.required("PUBLIC_API_CONTACT_EMAIL"))}`;
    return this.publicApiCall(request, context, capability, "crossref", "scholarly.crossref", { query: request.arguments.query }, url);
  }

  private packages(request: RequestOf<"packages.inspect">, context: ProviderExecutionContext, capability: Capability): Promise<ConcreteProviderResult> {
    const name = encodeURIComponent(request.arguments.package);
    const [provider, url] = request.arguments.registry === "NPM" ? ["npm", `https://registry.npmjs.org/${name}`]
      : request.arguments.registry === "PYPI" ? ["pypi", `https://pypi.org/pypi/${name}/json`]
      : ["hugging-face", `https://huggingface.co/api/models/${name}`];
    return this.publicApiCall(request, context, capability, provider, `packages.${request.arguments.registry.toLowerCase()}`, { registry: request.arguments.registry, package: request.arguments.package }, url);
  }

  private async securityRecords(request: RequestOf<"security_records.search">, context: ProviderExecutionContext, capability: Capability): Promise<ConcreteProviderResult> {
    if (request.arguments.cve) {
      if (this.environment.GITHUB_TOKEN) {
        try {
          const githubUrl = `https://api.github.com/advisories?cve_id=${encodeURIComponent(request.arguments.cve)}`;
          const github = await this.call(request, context, capability, "github-advisories", "security.github-advisories", { cve: request.arguments.cve }, async (signal, onAttempt) => ({ data: await apiFetch(githubUrl, { headers: { ...authHeaders(this.environment.GITHUB_TOKEN), accept: "application/vnd.github+json", "user-agent": this.publicUserAgent() }, signal }, onAttempt), sourceUrl: githubUrl, costUsd: 0, costSource: "FREE_PUBLIC" }));
          if (Array.isArray(github.data) && github.data.length > 0) return github;
        } catch { /* NVD is the explicit fallback */ }
      }
      const url = `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${encodeURIComponent(request.arguments.cve)}`;
      return this.publicApiCall(request, context, capability, "nvd", "security.nvd", { cve: request.arguments.cve }, url, this.environment.NVD_API_KEY ? { apiKey: this.environment.NVD_API_KEY } : {});
    }
    const url = "https://api.osv.dev/v1/query";
    const body = { package: { name: request.arguments.package, ecosystem: request.arguments.ecosystem } };
    return this.call(request, context, capability, "osv", "security.osv", body, async (signal, onAttempt) => ({ data: await apiFetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": this.publicUserAgent() }, body: JSON.stringify(body), signal }, onAttempt), sourceUrl: url, costUsd: 0, costSource: "FREE_PUBLIC" }));
  }

  private publicApiCall(request: AnyParsedToolRequest, context: ProviderExecutionContext, capability: Capability, provider: string, route: string, networkArguments: Record<string, unknown>, url: string, headers: Record<string, string> = {}): Promise<ConcreteProviderResult> {
    return this.call(request, context, capability, provider, route, networkArguments, async (signal, onAttempt) => ({
      data: await apiFetch(url, { headers: { "user-agent": this.publicUserAgent(), ...headers }, signal }, onAttempt),
      sourceUrl: url,
      costUsd: 0,
      costSource: "FREE_PUBLIC",
    }));
  }

  private call(request: AnyParsedToolRequest, context: ProviderExecutionContext, capability: Capability, provider: string, providerRoute: string, networkArguments: Record<string, unknown>, run: (signal: AbortSignal, onAttempt: (attempt: number) => void) => Promise<ProviderNetworkResult>, knownCost?: Pick<ProviderNetworkResult, "costUsd" | "costSource">): Promise<ConcreteProviderResult> {
    const arguments_ = request.arguments as { questionId?: string; claimIds?: string[]; publicRationale?: string };
    return this.executeProviderCall({
      context,
      ...(arguments_.questionId && arguments_.claimIds && arguments_.publicRationale ? {
        requestMetadata: { questionId: arguments_.questionId, claimIds: arguments_.claimIds, publicRationale: arguments_.publicRationale },
      } : {}),
      capability,
      semanticTool: request.tool,
      provider,
      providerRoute,
      networkArguments,
      countCeiling: this.toolCeiling(request.tool),
      providerBudgetUsd: nonNegativeNumber(this.environment.PROVIDER_BUDGET_USD, 10),
      knownCost,
      run,
    });
  }

  private async executeProviderCall(input: Parameters<ProviderCallBackend>[0]): Promise<ConcreteProviderResult> {
    return this.callBackend(input);
  }

  private combine(results: ConcreteProviderResult[], data: unknown): ConcreteProviderResult {
    if (results.length === 0) throw new Error("Cannot combine an empty provider response list.");
    const sources = results.map(({ costSource }) => costSource);
    const costSource: ProviderCostSource = sources.includes("UNKNOWN") ? "UNKNOWN"
      : sources.includes("REPORTED") ? "REPORTED"
      : sources.includes("CONFIGURED") ? "CONFIGURED" : "FREE_PUBLIC";
    return {
      provider: [...new Set(results.map(({ provider }) => provider))].join("+"),
      providerRoute: results.map(({ providerRoute }) => providerRoute).join("+"),
      data,
      sourceUrl: results[0]!.sourceUrl,
      costUsd: results.reduce((sum, result) => sum + result.costUsd, 0),
      costSource,
      artifactIds: results.flatMap(({ artifactIds }) => artifactIds),
      evidenceEligibleArtifactIds: results.flatMap(({ evidenceEligibleArtifactIds }) => evidenceEligibleArtifactIds),
      reused: results.every(({ reused }) => reused),
    };
  }

  private configuredCost(name: string, units = 1): Pick<ProviderNetworkResult, "costUsd" | "costSource"> {
    const value = this.environment[name];
    if (value === undefined || value.trim() === "") return { costUsd: 0, costSource: "UNKNOWN" };
    const configured = Number(value);
    return Number.isFinite(configured) && configured >= 0
      ? { costUsd: configured * units, costSource: "CONFIGURED" }
      : { costUsd: 0, costSource: "UNKNOWN" };
  }

  private exaCost(value: unknown): Pick<ProviderNetworkResult, "costUsd" | "costSource"> {
    if (!value || typeof value !== "object") return { costUsd: 0, costSource: "UNKNOWN" };
    const cost = (value as { costDollars?: { total?: unknown } }).costDollars?.total;
    return typeof cost === "number" && Number.isFinite(cost) && cost >= 0
      ? { costUsd: cost, costSource: "REPORTED" }
      : { costUsd: 0, costSource: "UNKNOWN" };
  }

  private firstRecord(value: unknown): Record<string, unknown> | undefined {
    const candidate = Array.isArray(value) ? value[0] : value;
    return candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : undefined;
  }

  private toolCeiling(tool: ToolName): number {
    return positiveNumber(this.environment[ceilingEnvironmentKeys[tool]], defaultToolCeilings[tool]);
  }

  private required(name: string): string {
    const value = this.environment[name];
    if (!value) throw new Error(`${name} is not configured.`);
    return value;
  }

  private publicUserAgent(): string {
    const contact = this.environment.PUBLIC_API_CONTACT_EMAIL;
    return contact ? `TranslucidInvestigator/0.1 (${contact})` : "TranslucidInvestigator/0.1";
  }
}
