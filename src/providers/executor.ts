import { randomUUID } from "node:crypto";
import type postgres from "postgres";

import { buildCapabilityRegistry, type Capability } from "../core/capabilities.ts";
import { getSql } from "../db/client.ts";
import { captureArtifact } from "../db/state.ts";
import {
  parseToolRequest,
  capabilityForRequest,
  shouldAllowSocialResearch,
  type ParsedToolRequest,
  type ToolName,
  type ToolResult,
  unavailableResult,
} from "./contracts.ts";
import { redactSecrets, safePublicFetch } from "./http.ts";
import { inspectGitHubRepository } from "./github-repository.ts";
import { fetchWithRetry } from "./retry.ts";
import { consumeBudget } from "./security.ts";

type Environment = Record<string, string | undefined>;
type ExecuteContext = { investigationId: string; runId: string; agent: string; sessionId: string };
type ProviderResponse = { provider: string; data: unknown; sourceUrl: string; costUsd?: number; status?: number };

const toolCeilings: Record<ToolName, number> = {
  "web.search": 15,
  "web.fetch": 30,
  "professional.profile": 3,
  "professional.activity": 3,
  "social.profile": 2,
  "github.graphql": 20,
  "github.rest": 30,
  "github.clone": 3,
  "archives.search": 8,
  "public_records.search": 8,
  "scholarly.search": 8,
  "packages.inspect": 8,
  "security_records.search": 8,
};

const researchAgentToolCeilings: Record<string, Partial<Record<ToolName, number>>> = {
  "professional-investigator": { "professional.profile": 2, "professional.activity": 1, "web.search": 3, "web.fetch": 4, "archives.search": 2 },
  "github-investigator": { "github.graphql": 2, "github.rest": 4, "github.clone": 1, "web.fetch": 1 },
  "web-records-investigator": { "web.search": 4, "web.fetch": 6, "archives.search": 2, "public_records.search": 1, "scholarly.search": 1, "packages.inspect": 1, "security_records.search": 1 },
  "social-investigator": { "social.profile": 2 },
};

export function agentToolCeiling(agent: string, tool: ToolName): number | undefined {
  return researchAgentToolCeilings[agent]?.[tool];
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

function asJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
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
    catch {
      const records = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
      return records;
    }
  }
  return { text };
}

async function apiFetch(url: string, init: RequestInit): Promise<unknown> {
  return readResponse(await fetchWithRetry(url, { ...init, signal: init.signal ?? AbortSignal.timeout(20_000) }));
}

function authHeaders(value: string | undefined, scheme = "Bearer"): Record<string, string> {
  return value ? { authorization: `${scheme} ${value}` } : {};
}

function fixtureData(request: ParsedToolRequest): unknown {
  const common = request.arguments as { questionId: string; claimIds: string[] };
  return {
    synthetic: true,
    tool: request.tool,
    questionId: common.questionId,
    claimIds: common.claimIds,
    records: request.tool === "professional.profile"
      ? [{ fullName: "Synthetic Candidate", headline: "Principal Engineer", positions: [{ company: "Acme Synthetic Labs", title: "Principal Engineer", start: "2021", end: "2025" }] }]
      : [{ title: "Synthetic fixture result", url: "https://example.test/synthetic-source", text: "Synthetic corroborating content for deterministic development tests." }],
  };
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

export class ProviderExecutor {
  private readonly registry;
  private readonly pools: Map<ToolName, Semaphore>;
  private readonly brightDataPool: Semaphore;

  constructor(private readonly environment: Environment = process.env) {
    this.registry = buildCapabilityRegistry(environment);
    this.pools = new Map(toolCeilings ? Object.keys(toolCeilings).map((tool) => [tool as ToolName, new Semaphore(concurrencyFor(tool as ToolName, environment))]) : []);
    this.brightDataPool = new Semaphore(Math.max(1, Number(environment.BRIGHTDATA_CONCURRENCY ?? 2)));
  }

  get capabilityRegistry() {
    return this.registry;
  }

  async execute(raw: unknown, context: ExecuteContext): Promise<ToolResult> {
    const request = parseToolRequest(raw);
    const capability = capabilityForRequest(request);
    const entry = this.registry[capability];
    if (!["READY", "READY_FIXTURE", "DEGRADED"].includes(entry.state)) return unavailableResult(capability);
    if (request.tool === "social.profile" && !shouldAllowSocialResearch((request.arguments as { reason: string }).reason)) return unavailableResult(capability);

    try {
      await this.assertQuestionScope(request, context);
      await consumeBudget({ runId: context.runId, counter: request.tool, increment: 1, ceiling: toolCeilings[request.tool] });
      const agentCeiling = agentToolCeiling(context.agent, request.tool);
      if (agentCeiling !== undefined) {
        await consumeBudget({ runId: context.runId, counter: `agent:${context.agent}:${request.tool}`, increment: 1, ceiling: agentCeiling });
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Budget exhausted")) {
        return { ...unavailableResult(capability), status: "BUDGET_EXHAUSTED" };
      }
      throw error;
    }

    const started = performance.now();
    const pool = this.pools.get(request.tool);
    if (!pool) throw new Error("Provider semaphore is missing.");
    try {
      const deadlineSignal = await this.deadlineSignal(context.runId);
      const work = () => this.environment.PROVIDER_MODE === "live" ? this.executeLive(request, context, deadlineSignal) : this.executeFixture(request);
      const response = request.tool === "social.profile" ? await work() : await pool.use(work);
      if ((response.costUsd ?? 0) > 0) {
        await consumeBudget({ runId: context.runId, counter: "providerUsd", increment: response.costUsd!, ceiling: Number(this.environment.PROVIDER_BUDGET_USD ?? 10) });
      }
      const artifact = await captureArtifact({
        ...context,
        kind: request.tool === "web.search" ? "SEARCH_DISCOVERY" : "PROVIDER_RESPONSE",
        provider: response.provider,
        sourceUrl: response.sourceUrl,
        mimeType: "application/json",
        content: JSON.stringify(response.data),
        provenance: {
          tool: request.tool,
          questionId: (request.arguments as { questionId: string }).questionId,
          isSearchSnippet: request.tool === "web.search",
          immutable: true,
        },
        httpMetadata: { status: response.status ?? 200 },
      });
      await this.recordCall(context, request, capability, response.provider, "OK", performance.now() - started, response.costUsd ?? 0, [artifact.id]);
      return { status: "OK", capability, provider: response.provider, data: response.data, artifactIds: [artifact.id], observedAt: new Date().toISOString(), costUsd: response.costUsd ?? 0 };
    } catch (error) {
      const status = typeof (error as { status?: unknown }).status === "number" ? Number((error as { status: number }).status) : undefined;
      const resultStatus = error instanceof Error && error.message.startsWith("Budget exhausted") ? "BUDGET_EXHAUSTED" : status === 429 ? "RATE_LIMITED" : "ERROR";
      await this.recordCall(context, request, capability, "gateway", resultStatus, performance.now() - started, 0, []);
      return { status: resultStatus, capability, provider: "gateway", data: { message: error instanceof Error ? error.message : "Provider request failed." }, artifactIds: [], observedAt: new Date().toISOString(), costUsd: 0 };
    }
  }

  private async assertQuestionScope(request: ParsedToolRequest, context: ExecuteContext): Promise<void> {
    const args = request.arguments as { questionId: string };
    const [question] = await getSql()<Array<{ status: string }>>`
      SELECT status FROM research_questions
      WHERE id = ${args.questionId} AND investigation_id = ${context.investigationId} AND run_id = ${context.runId}
    `;
    if (!question || !["OPEN", "IN_PROGRESS"].includes(question.status)) throw new Error("Tool request must reference an active research question in this run.");
  }

  private async executeFixture(request: ParsedToolRequest): Promise<ProviderResponse> {
    return { provider: "fixture", data: fixtureData(request), sourceUrl: `https://example.test/fixtures/${request.tool}` };
  }

  private async executeLive(request: ParsedToolRequest, context: ExecuteContext, signal: AbortSignal): Promise<ProviderResponse> {
    const args = request.arguments as Record<string, unknown>;
    switch (request.tool) {
      case "web.search": {
        const data = await apiFetch("https://api.exa.ai/search", { method: "POST", headers: { "content-type": "application/json", "x-api-key": this.required("EXA_API_KEY") }, body: JSON.stringify({ query: args.query, type: args.mode, numResults: 10 }), signal });
        return { provider: "exa", data, sourceUrl: "https://api.exa.ai/search" };
      }
      case "web.fetch": {
        const url = String(args.url);
        if (this.environment.EXA_API_KEY) {
          const data = await apiFetch("https://api.exa.ai/contents", { method: "POST", headers: { "content-type": "application/json", "x-api-key": this.environment.EXA_API_KEY }, body: JSON.stringify({ urls: [url], text: true }), signal });
          return { provider: "exa", data, sourceUrl: url };
        }
        const response = await safePublicFetch(url, { headers: { "user-agent": this.publicUserAgent() }, signal });
        return { provider: "public-fetch", data: await readResponse(response), sourceUrl: url, status: response.status };
      }
      case "professional.profile":
        return this.professionalProfile(args, context, signal);
      case "professional.activity": {
        const username = encodeURIComponent(String(args.username));
        if (this.environment.LINKDAPI_API_KEY) {
          try {
            await consumeBudget({ runId: context.runId, counter: "linkdapi", increment: 1, ceiling: 3 });
            const url = `https://linkdapi.com/api/v1/profile/posts?username=${username}`;
            const data = await apiFetch(url, { headers: { "X-linkdapi-apikey": this.environment.LINKDAPI_API_KEY }, signal });
            return { provider: "linkdapi", data, sourceUrl: url };
          } catch (error) {
            if (!this.environment.BRIGHTDATA_LINKEDIN_POSTS_DATASET_ID) throw error;
          }
        }
        return this.brightData(
          this.required("BRIGHTDATA_LINKEDIN_POSTS_DATASET_ID"),
          { url: `https://www.linkedin.com/in/${username}/recent-activity/all/` },
          "brightdata-linkedin-posts",
          context,
          signal,
        );
      }
      case "social.profile": {
        const platform = String(args.platform);
        const datasetKey = `BRIGHTDATA_${platform}_PROFILE_DATASET_ID`;
        return this.brightData(this.required(datasetKey), { url: String(args.handle) }, `brightdata-${platform.toLowerCase()}`, context, signal);
      }
      case "github.graphql": {
        const data = await apiFetch("https://api.github.com/graphql", { method: "POST", headers: { ...authHeaders(this.required("GITHUB_TOKEN")), "content-type": "application/json", "user-agent": this.publicUserAgent() }, body: JSON.stringify({ query: args.query, variables: args.variables }), signal });
        return { provider: "github", data, sourceUrl: "https://api.github.com/graphql" };
      }
      case "github.rest": {
        const url = `https://api.github.com${String(args.path)}`;
        const data = await apiFetch(url, { headers: { ...authHeaders(this.required("GITHUB_TOKEN")), accept: "application/vnd.github+json", "user-agent": this.publicUserAgent() }, signal });
        return { provider: "github", data, sourceUrl: url };
      }
      case "github.clone": {
        const repository = String(args.repository);
        const data = await inspectGitHubRepository({
          repository,
          ref: typeof args.ref === "string" ? args.ref : undefined,
          authorHint: typeof args.authorHint === "string" ? args.authorHint : undefined,
          signal,
        });
        return { provider: "github-public-clone", data, sourceUrl: `https://github.com/${repository}` };
      }
      case "archives.search": {
        return this.archives(args, signal);
      }
      case "public_records.search":
        return this.publicRecords(args, signal);
      case "scholarly.search":
        return this.scholarly(args, signal);
      case "packages.inspect":
        return this.packages(args, signal);
      case "security_records.search":
        return this.securityRecords(args, signal);
    }
  }

  private async professionalProfile(args: Record<string, unknown>, context: ExecuteContext, signal: AbortSignal): Promise<ProviderResponse> {
    const username = encodeURIComponent(String(args.username));
    if (this.environment.LINKDAPI_API_KEY) {
      try {
        await consumeBudget({ runId: context.runId, counter: "linkdapi", increment: 1, ceiling: 3 });
        const url = `https://linkdapi.com/api/v1/profile/full?username=${username}`;
        const data = await apiFetch(url, { headers: { "X-linkdapi-apikey": this.environment.LINKDAPI_API_KEY }, signal });
        const profile = unwrapLinkdProfileResponse(data);
        if (profile) return { provider: "linkdapi", data: profile, sourceUrl: url };
      } catch { /* one configured Bright Data fallback is allowed below */ }
    }
    const dataset = this.environment.BRIGHTDATA_LINKEDIN_PROFILE_DATASET_ID;
    if (!dataset) throw new Error("LinkdAPI failed or lacked the required field and Bright Data profile fallback is unavailable.");
    await consumeBudget({ runId: context.runId, counter: "brightdata.linkedinProfile", increment: 1, ceiling: 1 });
    return this.brightData(dataset, { url: `https://www.linkedin.com/in/${username}` }, "brightdata-linkedin-profile", context, signal);
  }

  private async archives(args: Record<string, unknown>, signal: AbortSignal): Promise<ProviderResponse> {
    const target = encodeURIComponent(String(args.url));
    const from = args.fromYear ? `&from=${args.fromYear}` : "";
    const to = args.toYear ? `&to=${args.toYear}` : "";
    const waybackUrl = `https://web.archive.org/cdx/search/cdx?url=${target}&output=json&filter=statuscode:200&filter=mimetype:text/html&collapse=digest&fl=timestamp,original,statuscode,mimetype,digest&limit=50${from}${to}`;
    try {
      const data = await apiFetch(waybackUrl, { headers: { "user-agent": this.publicUserAgent() }, signal });
      if (!Array.isArray(data)) return { provider: "wayback", data, sourceUrl: waybackUrl };
      if (data.length > 1) {
        const capture = data.at(-1);
        const timestamp = Array.isArray(capture) ? String(capture[0] ?? "") : "";
        const original = Array.isArray(capture) ? String(capture[1] ?? "") : "";
        if (/^\d{14}$/.test(timestamp) && /^https?:\/\//.test(original)) {
          const snapshotUrl = `https://web.archive.org/web/${timestamp}id_/${original}`;
          try {
            const historicalContent = await apiFetch(snapshotUrl, { headers: { "user-agent": this.publicUserAgent() }, signal });
            const boundedContent = historicalContent && typeof historicalContent === "object" && typeof (historicalContent as { text?: unknown }).text === "string"
              ? { ...(historicalContent as { text: string }), text: (historicalContent as { text: string }).text.slice(0, 4_000_000) }
              : historicalContent;
            return { provider: "wayback", data: { captures: data, retrievedCapture: { timestamp, original, snapshotUrl, content: boundedContent } }, sourceUrl: waybackUrl };
          } catch {
            if (signal.aborted) throw signal.reason;
          }
        }
        return { provider: "wayback", data: { captures: data, retrievedCapture: null }, sourceUrl: waybackUrl };
      }
    } catch {
      if (signal.aborted) throw signal.reason;
    }

    const indexListUrl = "https://index.commoncrawl.org/collinfo.json";
    const indexes = await apiFetch(indexListUrl, { headers: { "user-agent": this.publicUserAgent() }, signal });
    const currentIndex = Array.isArray(indexes) && indexes[0] && typeof indexes[0] === "object"
      ? String((indexes[0] as { id?: unknown }).id ?? "")
      : "";
    if (!/^CC-MAIN-\d{4}-\d{2}$/.test(currentIndex)) throw new Error("Common Crawl did not publish a valid current index.");
    const commonCrawlUrl = `https://index.commoncrawl.org/${currentIndex}-index?url=${target}&output=json&filter=status:200&filter=mime:text/html`;
    return { provider: "common-crawl", data: await apiFetch(commonCrawlUrl, { headers: { "user-agent": this.publicUserAgent() }, signal }), sourceUrl: commonCrawlUrl };
  }

  private async brightData(datasetId: string, payload: Record<string, unknown>, provider: string, context: ExecuteContext, signal: AbortSignal): Promise<ProviderResponse> {
    return this.brightDataPool.use(async () => {
      await consumeBudget({ runId: context.runId, counter: "brightdata", increment: 1, ceiling: 2 });
      const url = `https://api.brightdata.com/datasets/v3/scrape?dataset_id=${encodeURIComponent(datasetId)}&format=json`;
      const data = await apiFetch(url, { method: "POST", headers: { ...authHeaders(this.required("BRIGHTDATA_API_KEY")), "content-type": "application/json" }, body: JSON.stringify([payload]), signal });
      return { provider, data, sourceUrl: "https://api.brightdata.com/datasets/v3/scrape" };
    });
  }

  private async publicRecords(args: Record<string, unknown>, signal: AbortSignal): Promise<ProviderResponse> {
    const query = encodeURIComponent(String(args.query));
    if (args.recordType === "PATENT") {
      const url = `https://api.uspto.gov/api/v1/patent/applications/search?q=${query}`;
      return { provider: "uspto-odp", data: await apiFetch(url, { headers: { "x-api-key": this.required("USPTO_API_KEY") }, signal }), sourceUrl: url };
    }
    if (args.recordType === "SEC") {
      const url = `https://efts.sec.gov/LATEST/search-index?q=${query}&from=0&size=20`;
      return { provider: "sec-edgar", data: await apiFetch(url, { headers: { "user-agent": this.publicUserAgent() }, signal }), sourceUrl: url };
    }
    const url = `https://datatracker.ietf.org/api/v1/doc/document/?name__icontains=${query}&limit=20&format=json`;
    return { provider: "ietf-datatracker", data: await apiFetch(url, { headers: { "user-agent": this.publicUserAgent() }, signal }), sourceUrl: url };
  }

  private async scholarly(args: Record<string, unknown>, signal: AbortSignal): Promise<ProviderResponse> {
    const query = encodeURIComponent(String(args.query));
    if (this.environment.OPENALEX_API_KEY) {
      const url = `https://api.openalex.org/works?search=${query}&per-page=20&api_key=${encodeURIComponent(this.environment.OPENALEX_API_KEY)}`;
      return { provider: "openalex", data: await apiFetch(url, { headers: { "user-agent": this.publicUserAgent() }, signal }), sourceUrl: `https://api.openalex.org/works?search=${query}&per-page=20` };
    }
    const url = `https://api.crossref.org/works?query=${query}&rows=20&mailto=${encodeURIComponent(this.required("PUBLIC_API_CONTACT_EMAIL"))}`;
    return { provider: "crossref", data: await apiFetch(url, { headers: { "user-agent": this.publicUserAgent() }, signal }), sourceUrl: url };
  }

  private async packages(args: Record<string, unknown>, signal: AbortSignal): Promise<ProviderResponse> {
    const name = encodeURIComponent(String(args.package));
    const [provider, url] = args.registry === "NPM" ? ["npm", `https://registry.npmjs.org/${name}`]
      : args.registry === "PYPI" ? ["pypi", `https://pypi.org/pypi/${name}/json`]
      : ["hugging-face", `https://huggingface.co/api/models/${name}`];
    return { provider, data: await apiFetch(url, { headers: { "user-agent": this.publicUserAgent() }, signal }), sourceUrl: url };
  }

  private async securityRecords(args: Record<string, unknown>, signal: AbortSignal): Promise<ProviderResponse> {
    if (args.cve) {
      if (this.environment.GITHUB_TOKEN) {
        const githubUrl = `https://api.github.com/advisories?cve_id=${encodeURIComponent(String(args.cve))}`;
        try {
          const data = await apiFetch(githubUrl, { headers: { ...authHeaders(this.environment.GITHUB_TOKEN), accept: "application/vnd.github+json", "user-agent": this.publicUserAgent() }, signal });
          if (Array.isArray(data) && data.length > 0) return { provider: "github-advisories", data, sourceUrl: githubUrl };
        } catch {
          if (signal.aborted) throw signal.reason;
        }
      }
      const url = `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${encodeURIComponent(String(args.cve))}`;
      return { provider: "nvd", data: await apiFetch(url, { headers: { ...(this.environment.NVD_API_KEY ? { apiKey: this.environment.NVD_API_KEY } : {}), "user-agent": this.publicUserAgent() }, signal }), sourceUrl: url };
    }
    const url = "https://api.osv.dev/v1/query";
    const data = await apiFetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": this.publicUserAgent() }, body: JSON.stringify({ package: { name: args.package, ecosystem: args.ecosystem } }), signal });
    return { provider: "osv", data, sourceUrl: url };
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

  private async deadlineSignal(runId: string): Promise<AbortSignal> {
    const [run] = await getSql()<Array<{ deadline_at: Date | string | null }>>`
      SELECT deadline_at FROM runs WHERE id = ${runId}
    `;
    const deadline = run?.deadline_at ? new Date(run.deadline_at).getTime() : Date.now() + 20_000;
    const remaining = Math.max(1, Math.min(20_000, deadline - Date.now()));
    return AbortSignal.timeout(remaining);
  }

  private async recordCall(context: ExecuteContext, request: ParsedToolRequest, capability: Capability, provider: string, status: string, latencyMs: number, costUsd: number, artifactIds: string[]): Promise<void> {
    const metadata = redactSecrets({ tool: request.tool, arguments: request.arguments }) as Record<string, unknown>;
    await getSql()`
      INSERT INTO provider_calls (
        id, investigation_id, run_id, capability, provider, request_metadata,
        latency_ms, result_status, cost_usd, artifact_ids
      ) VALUES (
        ${randomUUID()}, ${context.investigationId}, ${context.runId}, ${capability},
        ${provider}, ${getSql().json(asJson(metadata))}, ${Math.max(0, Math.round(latencyMs))},
        ${status}, ${Math.max(0, costUsd)}, ${artifactIds}::uuid[]
      )
    `;
  }
}
