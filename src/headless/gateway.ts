import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { estimateModelInputTokens, modelCostReservation, proxyModelCompletion } from "../gateway/model-proxy.ts";
import { toolNames } from "../providers/contracts.ts";
import type { ProviderExecutor } from "../providers/executor.ts";
import type { MemoryRunBudget } from "./budget.ts";
import { SessionExcerptAllowances } from "./excerpt-allowance.ts";
import { reportToolNames, ReportStoreError, type ReportStore } from "./report-store.ts";
import type { FileSourceStore } from "./source-store.ts";

const MAX_TOOL_BODY = 1024 * 1024;
const MAX_MODEL_BODY = 16 * 1024 * 1024;
class GatewayError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

async function readJson(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > limit) throw new GatewayError(413, "Request body is too large.");
    chunks.push(bytes);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new GatewayError(400, "Valid JSON is required."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new GatewayError(400, "JSON object body is required.");
  return parsed as Record<string, unknown>;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
}

type GatewayInput = {
  runId: string;
  deadlineAt: number;
  allowedTools: Set<string>;
  allowedModels: Set<string>;
  executor?: ProviderExecutor;
  sourceStore: FileSourceStore;
  budget: MemoryRunBudget;
  providerMode: "fixture" | "live";
  agentTools?: Map<string, Set<string>>;
  reportStore?: ReportStore;
  persistResearchMemo?: (value: unknown) => Promise<unknown>;
  persistResearchNotebook?: (value: unknown) => Promise<unknown>;
  persistResearchLedger?: (value: unknown) => Promise<unknown>;
  researchUpstreamUrl?: string;
  fixtureCompletion?: (body: Record<string, unknown>, agent: string, model: string) => Promise<{ content?: string; toolCall?: { name: string; arguments: Record<string, unknown> } }>;
  onModelRequest?: (request: { agent: string; estimatedInputTokens: number }) => void;
};

export function createHeadlessGateway(input: GatewayInput) {
  const token = randomBytes(32).toString("base64url");
  const tokenDigest = digest(token);
  const excerptAllowances = new SessionExcerptAllowances();
  const reportTools = new Set<string>(reportToolNames);
  let active = true;
  let phase: "RESEARCHING" | "DRAFTING" | "AUDITING" = "RESEARCHING";
  const researchOnlyTools = new Set(["research.memo.persist", "research.notebook.set", "research.ledger.upsert"]);
  const frozenReadTools = new Set(["source.excerpts", "source.index"]);

  function sourceRefs(value: unknown, output: Set<string> = new Set()): Set<string> {
    if (!value || typeof value !== "object") return output;
    if (Array.isArray(value)) {
      for (const item of value) sourceRefs(item, output);
      return output;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "sourceRef" && typeof child === "string" && /^S[1-9]\d*$/.test(child)) output.add(child);
      else if ((key === "sourceRefs" || key === "evidenceEligibleSourceRefs") && Array.isArray(child)) {
        for (const ref of child) if (typeof ref === "string" && /^S[1-9]\d*$/.test(ref)) output.add(ref);
      }
      sourceRefs(child, output);
    }
    return output;
  }

  function recordSessionSources(sessionId: string, value: unknown): void {
    const refs = sessionSources.get(sessionId) ?? new Set<string>();
    for (const ref of sourceRefs(value)) refs.add(ref);
    sessionSources.set(sessionId, refs);
  }

  const sessionSources = new Map<string, Set<string>>();

  const authorize = (request: IncomingMessage, kind: "tool" | "model", name: string): void => {
    const header = request.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const alternate = typeof request.headers["x-api-key"] === "string" ? request.headers["x-api-key"] : "";
    if (bearer && alternate && bearer !== alternate) throw new GatewayError(401, "Conflicting run credentials.");
    const provided = bearer || alternate;
    const providedDigest = digest(provided);
    if (!active || Date.now() >= input.deadlineAt || provided.length > 256 || !timingSafeEqual(providedDigest, tokenDigest)) throw new GatewayError(401, "Unauthorized or expired run token.");
    if (request.headers["x-run-id"] !== input.runId) throw new GatewayError(401, "Run scope mismatch.");
    const allowed = kind === "tool" ? input.allowedTools : input.allowedModels;
    if (!allowed.has(name)) throw new GatewayError(403, `Run scope denies ${name}.`);
    if (kind === "tool" && input.agentTools) {
      const agent = typeof request.headers["x-opencode-agent"] === "string" ? request.headers["x-opencode-agent"] : "unknown-agent";
      if (!input.agentTools.get(agent)?.has(name)) throw new GatewayError(403, `Agent ${agent} cannot use ${name}.`);
    }
    if (kind === "tool") {
      if (phase === "RESEARCHING" && reportTools.has(name)) throw new GatewayError(403, "Report tools are unavailable until drafting begins.");
      if (phase !== "RESEARCHING" && !reportTools.has(name) && !frozenReadTools.has(name)) throw new GatewayError(403, `${phase} phase denies ${name}.`);
      if (phase !== "RESEARCHING" && researchOnlyTools.has(name)) throw new GatewayError(403, `${phase} phase denies ${name}.`);
      if (phase === "DRAFTING" && name === "report.finalize") throw new GatewayError(403, "Drafting phase denies report.finalize; the separate audit phase must finalize.");
    }
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://gateway.invalid");
      if (request.method === "POST" && url.pathname === "/internal/tools/execute") {
        const body = await readJson(request, MAX_TOOL_BODY);
        const name = typeof body.tool === "string" ? body.tool : "";
        authorize(request, "tool", name);
        if (name === "research.memo.persist") {
          if (!input.persistResearchMemo) throw new GatewayError(403, "Host memo persistence is unavailable in this run.");
          return json(response, 200, await input.persistResearchMemo(body.arguments));
        }
        if (name === "research.notebook.set") {
          if (!input.persistResearchNotebook) throw new GatewayError(403, "Host notebook persistence is unavailable in this run.");
          return json(response, 200, await input.persistResearchNotebook(body.arguments));
        }
        if (name === "research.ledger.upsert") {
          if (!input.persistResearchLedger) throw new GatewayError(403, "Host ledger persistence is unavailable in this run.");
          const operational = body.operational && typeof body.operational === "object" ? body.operational as Record<string, unknown> : {};
          const sessionId = typeof operational.sessionId === "string" ? operational.sessionId : "unknown-session";
          const role = typeof request.headers["x-opencode-agent"] === "string" ? request.headers["x-opencode-agent"] : "unknown-agent";
          const argumentsValue = body.arguments && typeof body.arguments === "object" ? body.arguments as Record<string, unknown> : {};
          return json(response, 200, await input.persistResearchLedger({ ...argumentsValue, sessionId, role, encounteredSourceRefs: [...(sessionSources.get(sessionId) ?? [])] }));
        }
        if (reportTools.has(name)) {
          if (!input.reportStore) throw new GatewayError(403, "Report publishing is unavailable in this run.");
          let result: unknown;
          if (name === "report.summary.set") result = await input.reportStore.setSummary(body.arguments);
          else if (name === "report.finding.upsert") result = await input.reportStore.upsertFinding(body.arguments);
          else if (name === "report.finding.remove") result = await input.reportStore.removeFinding(body.arguments);
          else if (name === "report.progress.get") result = await input.reportStore.progress();
          else if (name === "report.finalize") result = await input.reportStore.finalize();
          const operational = body.operational && typeof body.operational === "object" ? body.operational as Record<string, unknown> : {};
          await input.reportStore.recordToolCall({
            tool: name,
            sessionId: typeof operational.sessionId === "string" ? operational.sessionId : "unknown-session",
            agent: typeof request.headers["x-opencode-agent"] === "string" ? request.headers["x-opencode-agent"] : "unknown-agent",
            callId: typeof operational.callId === "string" ? operational.callId : "unknown-call",
          });
          return json(response, 200, result);
        }
        if (name === "source.excerpts") {
          const args = body.arguments && typeof body.arguments === "object" ? body.arguments as Record<string, unknown> : {};
          const operational = body.operational && typeof body.operational === "object" ? body.operational as Record<string, unknown> : {};
          const sessionId = typeof operational.sessionId === "string" ? operational.sessionId : "unknown-session";
          const agent = typeof request.headers["x-opencode-agent"] === "string" ? request.headers["x-opencode-agent"] : "unknown-agent";
          const sourceRef = typeof args.sourceRef === "string" ? args.sourceRef : "";
          const queries = Array.isArray(args.queries) ? args.queries.filter((value): value is string => typeof value === "string") : [];
          const requestedCharacters = typeof args.maxCharacters === "number" && Number.isFinite(args.maxCharacters)
            ? Math.min(60_000, Math.max(1, Math.floor(args.maxCharacters)))
            : 60_000;
          const excerpt = await excerptAllowances.execute(
            sessionId,
            sourceRef,
            requestedCharacters,
            (maximumCharacters) => input.sourceStore.excerpts({ sourceRef, queries, maxCharacters: maximumCharacters }),
          );
          recordSessionSources(sessionId, excerpt);
          return json(response, 200, excerpt);
        }
        if (name === "source.index") {
          const args = body.arguments && typeof body.arguments === "object" ? body.arguments as Record<string, unknown> : {};
          const queries = Array.isArray(args.queries) ? args.queries.filter((value): value is string => typeof value === "string") : [];
          const sourceRefs = Array.isArray(args.sourceRefs) ? args.sourceRefs.filter((value): value is string => typeof value === "string") : undefined;
          const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.floor(args.limit) : undefined;
          const indexed = await input.sourceStore.index({ queries, ...(sourceRefs ? { sourceRefs } : {}), ...(limit === undefined ? {} : { limit }) });
          const operational = body.operational && typeof body.operational === "object" ? body.operational as Record<string, unknown> : {};
          const sessionId = typeof operational.sessionId === "string" ? operational.sessionId : "unknown-session";
          recordSessionSources(sessionId, indexed);
          return json(response, 200, indexed);
        }
        if (!toolNames.includes(name as (typeof toolNames)[number])) throw new GatewayError(403, "State and database tools are unavailable in headless runs.");
        if (!input.executor) throw new GatewayError(403, "Research providers are unavailable during publishing-only recovery.");
        const operational = body.operational && typeof body.operational === "object" ? body.operational as Record<string, unknown> : {};
        const result = await input.executor.executeHeadless({ tool: name, arguments: body.arguments }, {
          runId: input.runId,
          agent: typeof operational.agent === "string" ? operational.agent : "unknown-agent",
          sessionId: typeof operational.sessionId === "string" ? operational.sessionId : "unknown-session",
        });
        return json(response, 200, result);
      }
      if (request.method === "POST" && url.pathname === "/internal/llm/v1/chat/completions") {
        const body = await readJson(request, MAX_MODEL_BODY);
        const model = typeof body.model === "string" ? body.model.split("/").at(-1) ?? "" : "";
        authorize(request, "model", model);
        const agent = typeof request.headers["x-opencode-agent"] === "string" ? request.headers["x-opencode-agent"] : "unknown-agent";
        const remainingMs = input.deadlineAt - Date.now();
        if (remainingMs <= 0) throw new GatewayError(401, "Investigation deadline reached.");
        input.onModelRequest?.({ agent, estimatedInputTokens: estimateModelInputTokens(body) });
        await input.budget.reserveModel(modelCostReservation(body, model));
        await proxyModelCompletion({
          request,
          response,
          body,
          agent,
          model,
          remainingMs,
          providerMode: input.providerMode,
          upstreamKey: process.env.OPENCODE_API_KEY,
          researchUpstreamUrl: input.researchUpstreamUrl ?? "https://opencode.ai/zen/v1/chat/completions",
          fixtureCompletion: () => input.fixtureCompletion?.(body, agent, model) ?? Promise.resolve({ content: "Headless fixture model completed." }),
        });
        return;
      }
      json(response, 404, { error: { code: "NOT_FOUND", message: "Not found." } });
    } catch (error) {
      if (response.headersSent || response.writableEnded || response.destroyed) {
        if (!response.destroyed) response.destroy();
        return;
      }
      if (error instanceof ReportStoreError) {
        return json(response, 422, { error: { code: error.code, ...(error.field ? { field: error.field } : {}), message: error.message } });
      }
      const status = error instanceof GatewayError ? error.status : 400;
      json(response, status, { error: { code: "GATEWAY_REJECTED", message: error instanceof Error ? error.message : "Gateway rejected request." } });
    }
  });

  return {
    server,
    token,
    registerExcerptAllowance: (sessionId: string, characters: number) => excerptAllowances.register(sessionId, characters),
    setPhase: (value: "RESEARCHING" | "DRAFTING" | "AUDITING") => { phase = value; },
    cancel: () => { active = false; },
  };
}
