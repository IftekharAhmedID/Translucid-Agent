import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";

import { estimateModelInputTokens, modelCostReservation, proxyModelCompletion, type ResearchUpstreamFamily } from "../gateway/model-proxy.ts";
import { toolNames } from "../providers/contracts.ts";
import type { ProviderExecutor } from "../providers/executor.ts";
import type { MemoryRunBudget } from "./budget.ts";
import { modelUsesResponses } from "./model-registry.ts";
import { SessionExcerptAllowances } from "./excerpt-allowance.ts";
import { reportToolNames, ReportStoreError, type ReportStore } from "./report-store.ts";
import { ResearchStateError, type ResearchStateStore } from "./research-state.ts";
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
  deadlineAt?: number;
  researchDeadlineAt?: number;
  allowedTools: Set<string>;
  allowedModels: Set<string>;
  executor?: ProviderExecutor;
  sourceStore: FileSourceStore;
  budget: MemoryRunBudget;
  providerMode: "fixture" | "live";
  agentTools?: Map<string, Set<string>>;
  reportStore?: ReportStore;
  researchState?: ResearchStateStore;
  researchUpstreamFamily?: ResearchUpstreamFamily;
  expectedReasoningEffort?: string;
  fixtureCompletion?: (body: Record<string, unknown>, agent: string, model: string) => Promise<{ content?: string; toolCall?: { name: string; arguments: Record<string, unknown> } }>;
  onModelRequest?: (request: { agent: string; estimatedInputTokens: number; reasoningEffort: string | null }) => void;
  onActivity?: (event: { kind: "model-start" | "model-end" | "tool-start" | "tool-end"; name: string; at: number }) => void;
};

export function sanitizeReasoningEffort(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLocaleLowerCase("en-US");
  return ["low", "medium", "high", "max", "xhigh"].includes(normalized) ? normalized : null;
}

export function createHeadlessGateway(input: GatewayInput) {
  const token = randomBytes(32).toString("base64url");
  const tokenDigest = digest(token);
  const excerptAllowances = new SessionExcerptAllowances();
  const reportTools = new Set<string>(reportToolNames);
  const investigationTools = new Set([
    "investigation.plan.set",
    "investigation.target.add",
    "investigation.synthesis.begin",
    "investigation.finding.upsert",
    "investigation.progress.get",
    "investigation.summary.set",
    "investigation.commit",
  ]);
  const investigationMutationTools = new Set([
    "investigation.plan.set",
    "investigation.target.add",
    "investigation.synthesis.begin",
    "investigation.finding.upsert",
    "investigation.summary.set",
    "investigation.commit",
  ]);
  let active = true;
  let phase: "RESEARCHING" | "FREEZING" | "PUBLISHING" | "ACTIVE" | "COMMITTING" | "FROZEN" = "ACTIVE";
  let leadSessionId: string | undefined;
  let providersInFlight = 0;
  let synthesisActive = false;
  let providerCallsDuringSynthesis = 0;
  let modelRequests = 0;
  let nonLeadSemanticModelRequests = 0;
  let reportWriterModelRequests = 0;
  const observedReasoningEfforts = new Set<string>();
  const modelTiming = new Map<string, { requests: number; totalElapsedMs: number; maxElapsedMs: number }>();
  const providerTiming = new Map<string, { requests: number; totalElapsedMs: number; maxElapsedMs: number }>();
  const providerDrainWaiters: Array<() => void> = [];
  let commitOperation: Promise<{ ok: true; phase: "FROZEN"; revision: number }> | undefined;

  function waitForProviderDrain(): Promise<void> {
    if (providersInFlight === 0) return Promise.resolve();
    return new Promise((resolve) => providerDrainWaiters.push(resolve));
  }

  function finishProviderCall(): void {
    providersInFlight -= 1;
    if (providersInFlight === 0) while (providerDrainWaiters.length) providerDrainWaiters.shift()!();
  }

  function authorizeOperationalSession(body: Record<string, unknown>): Record<string, unknown> {
    const operational = body.operational && typeof body.operational === "object" ? body.operational as Record<string, unknown> : {};
    const sessionId = typeof operational.sessionId === "string" ? operational.sessionId : "";
    if (!leadSessionId) throw new GatewayError(403, "Lead session is not registered.");
    if (sessionId !== leadSessionId) throw new GatewayError(403, "Tool session does not match the registered lead session.");
    return operational;
  }

  async function commitInvestigation(): Promise<{ ok: true; phase: "FROZEN"; revision: number }> {
    if (!input.researchState) throw new GatewayError(403, "Investigation state is unavailable in this run.");
    if (commitOperation) return commitOperation;
    if (phase === "FROZEN") {
      const current = await input.researchState.current();
      if (current?.schemaVersion === 3 && current.phase === "COMMITTED") return { ok: true, phase: "FROZEN", revision: current.revision };
    }
    const operation: Promise<{ ok: true; phase: "FROZEN"; revision: number }> = (async () => {
      // Prevalidation happens while the gateway is still ACTIVE, so a
      // rejected commit leaves the lead free to repair the exact defect.
      await input.researchState!.validateCommit();
      phase = "COMMITTING";
      try {
        await waitForProviderDrain();
        // current() drains serialized state writes; the host then refreshes
        // the source/route inventory before final validation.
        await input.researchState!.current();
        await input.researchState!.sealHostInventory();
        await input.researchState!.validateCommit();
        const committed = await input.researchState!.commit();
        await input.researchState!.flushEvents();
        phase = "FROZEN";
        return { ok: true as const, phase: "FROZEN" as const, revision: committed.revision };
      } catch (error) {
        phase = "ACTIVE";
        throw error;
      }
    })();
    commitOperation = operation.finally(() => { commitOperation = undefined; });
    return commitOperation!;
  }

  const authorize = (request: IncomingMessage, kind: "tool" | "model", name: string): void => {
    const header = request.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const alternate = typeof request.headers["x-api-key"] === "string" ? request.headers["x-api-key"] : "";
    if (bearer && alternate && bearer !== alternate) throw new GatewayError(401, "Conflicting run credentials.");
    const provided = bearer || alternate;
    const providedDigest = digest(provided);
    const now = Date.now();
    if (!active || (input.deadlineAt !== undefined && now >= input.deadlineAt) || provided.length > 256 || !timingSafeEqual(providedDigest, tokenDigest)) throw new GatewayError(401, "Unauthorized or expired run token.");
    if (request.headers["x-run-id"] !== input.runId) throw new GatewayError(401, "Run scope mismatch.");
    const allowed = kind === "tool" ? input.allowedTools : input.allowedModels;
    if (!allowed.has(name)) throw new GatewayError(403, `Run scope denies ${name}.`);
    if (kind === "tool" && input.agentTools) {
      const agent = typeof request.headers["x-opencode-agent"] === "string" ? request.headers["x-opencode-agent"] : "unknown-agent";
      if (!input.agentTools.get(agent)?.has(name)) throw new GatewayError(403, `Agent ${agent} cannot use ${name}.`);
    }
    if (kind === "model") {
      const agent = typeof request.headers["x-opencode-agent"] === "string" ? request.headers["x-opencode-agent"] : "unknown-agent";
      if (agent !== "lead-researcher") throw new GatewayError(403, "Only the lead investigator may make semantic model requests.");
    }
    if (kind === "tool") {
      if (reportTools.has(name) && phase !== "PUBLISHING") throw new GatewayError(403, "Report tools are unavailable until publishing begins.");
      if (investigationTools.has(name) && !input.researchState) throw new GatewayError(403, "Investigation state is unavailable in this run.");
      if (investigationMutationTools.has(name) && (phase === "COMMITTING" || phase === "FROZEN" || phase === "FREEZING" || phase === "PUBLISHING")) throw new GatewayError(403, "Investigation state is immutable while committing or after commit.");
      if (input.researchDeadlineAt !== undefined && now >= input.researchDeadlineAt && phase !== "COMMITTING") throw new GatewayError(403, "Research deadline reached; no new provider calls or semantic mutations are allowed.");
      if (name === "research.state.set" && phase !== "RESEARCHING" && phase !== "ACTIVE") throw new GatewayError(403, "Research state is immutable after research ends.");
      if (name !== "source.excerpts" && name !== "source.inventory" && name !== "research.state.set" && name !== "research.state.get" && !investigationTools.has(name) && !reportTools.has(name) && phase !== "RESEARCHING" && phase !== "ACTIVE") {
        throw new GatewayError(403, `Publishing phase denies ${name}.`);
      }
      if (investigationTools.has(name) && name !== "investigation.progress.get" && phase === "PUBLISHING") throw new GatewayError(403, "Publishing phase denies investigation mutations.");
    }
    if (kind === "model" && input.researchDeadlineAt !== undefined && now >= input.researchDeadlineAt) throw new GatewayError(401, "Research deadline reached; no new semantic model requests are allowed.");
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://gateway.invalid");
      if (request.method === "POST" && url.pathname === "/internal/tools/execute") {
        const body = await readJson(request, MAX_TOOL_BODY);
        const name = typeof body.tool === "string" ? body.tool : "";
        authorize(request, "tool", name);
        const operational = authorizeOperationalSession(body);
        if (name === "source.inventory") {
          if (!input.sourceStore) throw new GatewayError(403, "Source inventory is unavailable in this run.");
          const args = body.arguments && typeof body.arguments === "object" ? body.arguments as { cursor?: unknown; limit?: unknown } : {};
          return json(response, 200, await input.sourceStore.inventory({
            ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}),
            ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
          }));
        }
        if (name === "research.state.set") {
          if (!input.researchState) throw new GatewayError(403, "Research state is unavailable in this run.");
          return json(response, 200, await input.researchState.set(body.arguments));
        }
        if (name === "research.state.get") {
          if (!input.researchState) throw new GatewayError(403, "Research state is unavailable in this run.");
          const args = body.arguments && typeof body.arguments === "object" ? body.arguments as { cursor?: unknown; limit?: unknown } : {};
          return json(response, 200, await input.researchState.get({
            ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}),
            ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
          }));
        }
        if (investigationTools.has(name)) {
          if (!input.researchState) throw new GatewayError(403, "Investigation state is unavailable in this run.");
          let result: unknown;
          if (name === "investigation.plan.set") result = await input.researchState.planSet(body.arguments);
          else if (name === "investigation.target.add") result = await input.researchState.targetAdd(body.arguments);
          else if (name === "investigation.synthesis.begin") {
            result = await input.researchState.beginSynthesis();
            synthesisActive = true;
          }
          else if (name === "investigation.finding.upsert") result = await input.researchState.upsertFinding(body.arguments);
          else if (name === "investigation.progress.get") result = await input.researchState.progress();
          else if (name === "investigation.summary.set") result = await input.researchState.setSummary(body.arguments);
          else if (name === "investigation.commit") result = await commitInvestigation();
          await input.researchState.recordEvent({
            tool: name,
            sessionId: typeof operational.sessionId === "string" ? operational.sessionId : "unknown-session",
            agent: typeof request.headers["x-opencode-agent"] === "string" ? request.headers["x-opencode-agent"] : "unknown-agent",
            callId: typeof operational.callId === "string" ? operational.callId : undefined,
            phase,
          });
          return json(response, 200, result);
        }
        if (reportTools.has(name)) {
          if (!input.reportStore) throw new GatewayError(403, "Report publishing is unavailable in this run.");
          let result: unknown;
          if (name === "report.summary.set") result = await input.reportStore.setSummary(body.arguments);
          else if (name === "report.finding.upsert") result = await input.reportStore.upsertFinding(body.arguments);
          else if (name === "report.finding.remove") result = await input.reportStore.removeFinding(body.arguments);
          else if (name === "report.progress.get") result = await input.reportStore.progress();
          else if (name === "report.finalize") result = await input.reportStore.finalize();
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
          return json(response, 200, excerpt);
        }
        if (!toolNames.includes(name as (typeof toolNames)[number])) throw new GatewayError(403, "State and database tools are unavailable in headless runs.");
        if (!input.executor) throw new GatewayError(403, "Research providers are unavailable after publication begins.");
        input.researchState?.recordRoute(name);
        providersInFlight += 1;
        if (synthesisActive) providerCallsDuringSynthesis += 1;
        const providerStarted = performance.now();
        input.onActivity?.({ kind: "tool-start", name, at: Date.now() });
        try {
          const result = await input.executor.executeHeadless({ tool: name, arguments: body.arguments }, {
            runId: input.runId,
            agent: typeof operational.agent === "string" ? operational.agent : "unknown-agent",
            sessionId: typeof operational.sessionId === "string" ? operational.sessionId : "unknown-session",
          });
          return json(response, 200, {
            ...result,
            ...(input.deadlineAt === undefined ? {} : { timing: {
              ...(input.researchDeadlineAt === undefined ? {} : { researchDeadlineAt: input.researchDeadlineAt }),
              totalDeadlineAt: input.deadlineAt,
            } }),
          });
        } finally {
          const elapsedMs = Math.max(0, Math.round(performance.now() - providerStarted));
          const timing = providerTiming.get(name) ?? { requests: 0, totalElapsedMs: 0, maxElapsedMs: 0 };
          timing.requests += 1;
          timing.totalElapsedMs += elapsedMs;
          timing.maxElapsedMs = Math.max(timing.maxElapsedMs, elapsedMs);
          providerTiming.set(name, timing);
          input.onActivity?.({ kind: "tool-end", name, at: Date.now() });
          finishProviderCall();
        }
      }
      if (request.method === "POST" && (url.pathname === "/internal/llm/v1/chat/completions" || url.pathname === "/internal/llm/v1/responses")) {
        const body = await readJson(request, MAX_MODEL_BODY);
        const model = typeof body.model === "string" ? body.model.split("/").at(-1) ?? "" : "";
        authorize(request, "model", model);
        const responsesPath = url.pathname.endsWith("/responses");
        let responsesModel: boolean;
        try { responsesModel = modelUsesResponses(model); }
        catch { throw new GatewayError(400, `Unknown research model ${model || "unknown"}.`); }
        if (responsesPath !== responsesModel) {
          throw new GatewayError(400, `Model ${model || "unknown"} must use the ${responsesModel ? "Responses" : "Chat Completions"} endpoint.`);
        }
        const agent = typeof request.headers["x-opencode-agent"] === "string" ? request.headers["x-opencode-agent"] : "unknown-agent";
        const remainingMs = (input.researchDeadlineAt ?? input.deadlineAt) === undefined ? undefined : (input.researchDeadlineAt ?? input.deadlineAt)! - Date.now();
        if (remainingMs !== undefined && remainingMs <= 0) throw new GatewayError(401, "Investigation deadline reached.");
        const observedReasoningEffort = sanitizeReasoningEffort(body.reasoning_effort ?? body.reasoningEffort);
        if (input.expectedReasoningEffort && observedReasoningEffort !== input.expectedReasoningEffort) {
          throw new GatewayError(400, `Model reasoning_effort mismatch: expected ${input.expectedReasoningEffort}, observed ${observedReasoningEffort ?? "missing"}.`);
        }
        if (observedReasoningEffort) observedReasoningEfforts.add(observedReasoningEffort);
        input.onModelRequest?.({ agent, estimatedInputTokens: estimateModelInputTokens(body), reasoningEffort: observedReasoningEffort });
        modelRequests += 1;
        if (agent !== "lead-researcher") nonLeadSemanticModelRequests += 1;
        if (agent === "report-writer") reportWriterModelRequests += 1;
        input.onActivity?.({ kind: "model-start", name: model, at: Date.now() });
        const modelStarted = performance.now();
        try {
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
            researchUpstreamFamily: input.researchUpstreamFamily ?? "ZEN",
            fixtureCompletion: () => input.fixtureCompletion?.(body, agent, model) ?? Promise.resolve({ content: "Headless fixture model completed." }),
          });
        } finally {
          const elapsedMs = Math.max(0, Math.round(performance.now() - modelStarted));
          const timing = modelTiming.get(model) ?? { requests: 0, totalElapsedMs: 0, maxElapsedMs: 0 };
          timing.requests += 1;
          timing.totalElapsedMs += elapsedMs;
          timing.maxElapsedMs = Math.max(timing.maxElapsedMs, elapsedMs);
          modelTiming.set(model, timing);
          input.onActivity?.({ kind: "model-end", name: model, at: Date.now() });
        }
        return;
      }
      json(response, 404, { error: { code: "NOT_FOUND", message: "Not found." } });
    } catch (error) {
      if (response.headersSent || response.writableEnded || response.destroyed) {
        if (!response.destroyed) response.destroy();
        return;
      }
      if (error instanceof ReportStoreError || error instanceof ResearchStateError) {
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
    setLeadSession: (sessionId: string) => {
      if (!sessionId.trim()) throw new Error("Lead session ID is required.");
      if (leadSessionId && leadSessionId !== sessionId) throw new Error("Lead session ID cannot be changed.");
      leadSessionId = sessionId;
    },
    telemetry: () => ({
      semanticAgentCount: leadSessionId ? 1 : 0,
      modelRequests,
      providerCallsDuringSynthesis,
      nonLeadSemanticModelRequests,
      reportWriterModelRequests,
      observedReasoningEfforts: [...observedReasoningEfforts].sort(),
      modelTiming: Object.fromEntries(modelTiming),
      providerTiming: Object.fromEntries(providerTiming),
    }),
    setPhase: (value: "RESEARCHING" | "FREEZING" | "PUBLISHING" | "ACTIVE" | "COMMITTING" | "FROZEN") => { phase = value; },
    commitInvestigation,
    freezeResearch: async () => {
      phase = "FREEZING";
      await waitForProviderDrain();
      await input.researchState?.current();
    },
    cancel: () => { active = false; },
  };
}
