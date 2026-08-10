import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { getConfig } from "../core/config.ts";
import { getSql } from "../db/client.ts";
import { ProviderExecutor } from "../providers/executor.ts";
import { toolNames } from "../providers/contracts.ts";
import { authorizeCaseToken, consumeBudget } from "../providers/security.ts";
import { executeStateTool, isStateTool } from "./state-tools.ts";
import { fixtureCompletion, writeFixtureCompletion } from "./fixture-model.ts";
import { encodeModelToolNames, SseToolNameDecoder } from "./model-tool-names.ts";

const MAX_TOOL_BODY = 1024 * 1024;
const MAX_MODEL_BODY = 16 * 1024 * 1024;
const MODEL_IDS = new Set(["deepseek-v4-flash", "mimo-v2.5-free"]);

function bearer(request: IncomingMessage): string {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw new Error("Bearer case token is required.");
  return header.slice(7);
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || !value) throw new Error(`${name} header is required.`);
  return value;
}

async function readJson(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > limit) throw new Error("Request body is too large.");
    chunks.push(bytes);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON object body is required.");
  return parsed as Record<string, unknown>;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
}

export function canWriteGatewayError(response: Pick<ServerResponse, "headersSent" | "writableEnded" | "destroyed">): boolean {
  return !response.headersSent && !response.writableEnded && !response.destroyed;
}

function modelCostReservation(body: Record<string, unknown>, model: string): number {
  if (model === "mimo-v2.5-free") return 0;
  const inputCharacters = JSON.stringify(body.messages ?? []).length;
  const estimatedInputTokens = Math.ceil(inputCharacters / 4);
  const maximumOutputTokens = Math.min(Number(body.max_tokens ?? body.max_completion_tokens ?? 32_000), 384_000);
  return (estimatedInputTokens * 0.14 + maximumOutputTokens * 0.28) / 1_000_000;
}

async function handleTool(request: IncomingMessage, response: ServerResponse, executor: ProviderExecutor): Promise<void> {
  const investigationId = header(request, "x-investigation-id");
  const declaredRunId = header(request, "x-run-id");
  const body = await readJson(request, MAX_TOOL_BODY);
  const tool = typeof body.tool === "string" ? body.tool : "";
  if (!toolNames.includes(tool as (typeof toolNames)[number]) && !isStateTool(tool)) throw new Error("Unknown semantic tool.");
  const authorizedRunId = await authorizeCaseToken(bearer(request), { kind: "tool", name: tool, investigationId });
  if (authorizedRunId !== declaredRunId) throw new Error("Run scope mismatch.");
  const operational = body.operational && typeof body.operational === "object" ? body.operational as Record<string, unknown> : {};
  const context = {
    investigationId,
    runId: authorizedRunId,
    agent: typeof operational.agent === "string" ? operational.agent : "unknown-agent",
    sessionId: typeof operational.sessionId === "string" ? operational.sessionId : "unknown-session",
  };
  const result = isStateTool(tool)
    ? await executeStateTool(tool, body.arguments, context)
    : await executor.execute({ tool, arguments: body.arguments }, context);
  json(response, 200, result);
}

async function handleCompaction(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const investigationId = header(request, "x-investigation-id");
  const declaredRunId = header(request, "x-run-id");
  const runId = await authorizeCaseToken(bearer(request), { kind: "tool", name: "state.compaction", investigationId });
  if (runId !== declaredRunId) throw new Error("Run scope mismatch.");
  const [run, questions] = await Promise.all([
    getSql()<Array<{ deadlineAt: Date | null; budgetCounters: Record<string, number> }>>`SELECT deadline_at AS "deadlineAt", budget_counters AS "budgetCounters" FROM runs WHERE id = ${runId}`,
    getSql()<Array<{ id: string; question: string; status: string; selectedRoute: string | null }>>`SELECT id, question, status, selected_route AS "selectedRoute" FROM research_questions WHERE investigation_id = ${investigationId} AND status IN ('OPEN','IN_PROGRESS') ORDER BY created_at`,
  ]);
  response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  response.end([
    "Durable state survives compaction; do not reconstruct it from memory.",
    `Investigation ID: ${investigationId}`,
    `Run ID: ${runId}`,
    `Phase deadline: ${run[0]?.deadlineAt?.toISOString() ?? "not-set"}`,
    `Budget counters: ${JSON.stringify(run[0]?.budgetCounters ?? {})}`,
    `Unresolved research questions: ${JSON.stringify(questions)}`,
  ].join("\n"));
}

async function handleModel(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const investigationId = header(request, "x-investigation-id");
  const declaredRunId = header(request, "x-run-id");
  const body = await readJson(request, MAX_MODEL_BODY);
  const rawModel = typeof body.model === "string" ? body.model : "";
  const model = rawModel.split("/").at(-1) ?? "";
  if (!MODEL_IDS.has(model)) throw new Error("Model is not allowlisted for this case.");
  const runId = await authorizeCaseToken(bearer(request), { kind: "model", name: `opencode/${model}`, investigationId });
  if (runId !== declaredRunId) throw new Error("Run scope mismatch.");
  const [run] = await getSql()<Array<{ deadlineAt: Date | null; status: string }>>`
    SELECT deadline_at AS "deadlineAt", status FROM runs WHERE id = ${runId}
  `;
  if (!run || run.status !== "RUNNING") throw new Error("Run is not active.");
  const remaining = run.deadlineAt ? run.deadlineAt.getTime() - Date.now() : 300_000;
  if (remaining <= 0) throw new Error("Investigation deadline reached.");
  const reservation = modelCostReservation(body, model);
  if (reservation > 0) await consumeBudget({ runId, counter: "modelUsd", increment: reservation, ceiling: getConfig().modelBudgetUsd });

  if (getConfig().providerMode === "fixture") {
    writeFixtureCompletion(response, body, model, await fixtureCompletion(body, investigationId, runId));
    return;
  }

  const upstreamKey = process.env.OPENCODE_API_KEY;
  if (!upstreamKey) throw new Error("OPENCODE_API_KEY is not configured on the host gateway.");
  const encoded = encodeModelToolNames(body);
  const upstreamAbort = new AbortController();
  const timeout = setTimeout(() => upstreamAbort.abort(new DOMException("Investigation deadline reached.", "TimeoutError")), Math.min(remaining, 300_000));
  request.once("aborted", () => upstreamAbort.abort(new DOMException("Runtime request disconnected.", "AbortError")));
  response.once("close", () => upstreamAbort.abort(new DOMException("Runtime response disconnected.", "AbortError")));
  let upstream: Response;
  try {
    upstream = await fetch(getConfig().openCodeUpstreamUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${upstreamKey}`, "content-type": "application/json" },
      body: JSON.stringify({ ...encoded.body, model }),
      signal: upstreamAbort.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (!upstream.body) { clearTimeout(timeout); return void response.end(); }
  const reader = upstream.body.getReader();
  const toolNames = new SseToolNameDecoder(encoded.wireToSemantic);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const decoded = toolNames.push(value);
      if (decoded && !response.write(decoded)) await new Promise<void>((resolve) => response.once("drain", resolve));
    }
    const final = toolNames.flush();
    if (final) response.write(final);
  } finally {
    clearTimeout(timeout);
    response.end();
    reader.releaseLock();
  }
}

export function createGatewayServer(executor = new ProviderExecutor(process.env)) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://gateway.invalid");
      if (request.method === "POST" && url.pathname === "/internal/tools/execute") return await handleTool(request, response, executor);
      if (request.method === "POST" && url.pathname === "/internal/llm/v1/chat/completions") return await handleModel(request, response);
      if (request.method === "GET" && url.pathname === "/internal/state/compaction") return await handleCompaction(request, response);
      json(response, 404, { error: { code: "NOT_FOUND", message: "Not found." } });
    } catch (error) {
      if (!canWriteGatewayError(response)) {
        if (!response.destroyed) response.destroy();
        return;
      }
      json(response, 400, { error: { code: "GATEWAY_REJECTED", message: error instanceof Error ? error.message : "Gateway rejected request." } });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const origin = new URL(getConfig().runnerGatewayOrigin);
  const server = createGatewayServer();
  server.listen(Number(origin.port || 3001), origin.hostname, () => {
    process.stdout.write(`Gateway listening on ${origin.origin}\n`);
  });
}
