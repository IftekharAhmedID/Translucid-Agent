import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { modelCostReservation, proxyModelCompletion } from "../gateway/model-proxy.ts";
import { toolNames } from "../providers/contracts.ts";
import type { ProviderExecutor } from "../providers/executor.ts";
import type { MemoryRunBudget } from "./budget.ts";
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
  executor: ProviderExecutor;
  sourceStore: FileSourceStore;
  budget: MemoryRunBudget;
  providerMode: "fixture" | "live";
  agentTools?: Map<string, Set<string>>;
  researchUpstreamUrl?: string;
  finalizerUpstreamUrl?: string;
  finalizerProvider?: "ZEN" | "GO";
  finalizerModel?: string;
  fixtureCompletion?: (body: Record<string, unknown>, agent: string, model: string) => Promise<{ content?: string; toolCall?: { name: string; arguments: Record<string, unknown> } }>;
};

export function createHeadlessGateway(input: GatewayInput) {
  const token = randomBytes(32).toString("base64url");
  const tokenDigest = digest(token);
  let active = true;

  const authorize = (request: IncomingMessage, kind: "tool" | "model", name: string): void => {
    const header = request.headers.authorization;
    const provided = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const providedDigest = digest(provided);
    if (!active || Date.now() >= input.deadlineAt || provided.length > 256 || !timingSafeEqual(providedDigest, tokenDigest)) throw new GatewayError(401, "Unauthorized or expired run token.");
    if (request.headers["x-run-id"] !== input.runId) throw new GatewayError(401, "Run scope mismatch.");
    const allowed = kind === "tool" ? input.allowedTools : input.allowedModels;
    if (!allowed.has(name)) throw new GatewayError(403, `Run scope denies ${name}.`);
    if (kind === "tool" && input.agentTools) {
      const agent = typeof request.headers["x-opencode-agent"] === "string" ? request.headers["x-opencode-agent"] : "unknown-agent";
      if (!input.agentTools.get(agent)?.has(name)) throw new GatewayError(403, `Agent ${agent} cannot use ${name}.`);
    }
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://gateway.invalid");
      if (request.method === "POST" && url.pathname === "/internal/tools/execute") {
        const body = await readJson(request, MAX_TOOL_BODY);
        const name = typeof body.tool === "string" ? body.tool : "";
        authorize(request, "tool", name);
        if (name === "source.excerpts") {
          const args = body.arguments && typeof body.arguments === "object" ? body.arguments as Record<string, unknown> : {};
          const sourceRef = typeof args.sourceRef === "string" ? args.sourceRef : "";
          const queries = Array.isArray(args.queries) ? args.queries.filter((value): value is string => typeof value === "string") : [];
          const maxCharacters = typeof args.maxCharacters === "number" ? args.maxCharacters : undefined;
          return json(response, 200, await input.sourceStore.excerpts({ sourceRef, queries, ...(maxCharacters === undefined ? {} : { maxCharacters }) }));
        }
        if (!toolNames.includes(name as (typeof toolNames)[number])) throw new GatewayError(403, "State and database tools are unavailable in headless runs.");
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
        input.budget.reserveModel(modelCostReservation(body, model));
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
          finalizerUpstreamUrl: input.finalizerUpstreamUrl ?? "https://opencode.ai/zen/go/v1/chat/completions",
          finalizerProvider: input.finalizerProvider ?? "GO",
          finalizerModel: input.finalizerModel ?? "deepseek-v4-pro",
          finalizerAgents: new Set(["evidence-compiler", "evidence-auditor"]),
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
      const status = error instanceof GatewayError ? error.status : 400;
      json(response, status, { error: { code: "GATEWAY_REJECTED", message: error instanceof Error ? error.message : "Gateway rejected request." } });
    }
  });

  return { server, token, cancel: () => { active = false; } };
}
