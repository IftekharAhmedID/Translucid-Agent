import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";

import { decodeJsonToolNames, encodeModelToolNames, SseToolNameDecoder } from "./model-tool-names.ts";
import { writeFixtureCompletion, type Completion } from "./fixture-model.ts";
import { modelUsesResponses, resolveResearchModel } from "../headless/model-registry.ts";

export class ModelUpstreamError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter?: string) { super(message); }
}

export function modelCostReservation(body: Record<string, unknown>, model: string): number {
  if (model === "big-pickle" || model === "cat-jam-free" || model === "muse-spark-1.3-contributor-free") return 0;
  const estimatedInputTokens = estimateModelInputTokens(body);
  const maximumOutputTokens = Math.max(0, Math.min(Number(body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens ?? 32_000), 384_000));
  // Conservative peak rates; no cache discounts. Review against provider pricing before enabling a paid route.
  const rates = model === "deepseek-v4-pro" ? { inputUsdPerMillion: 1.32, outputUsdPerMillion: 3.96 }
    : model === "deepseek-v4-flash" ? { inputUsdPerMillion: 0.30, outputUsdPerMillion: 0.60 }
    : model === "deepseek/deepseek-v4.1-flash" ? { inputUsdPerMillion: 0.30, outputUsdPerMillion: 1.20 }
    : model === "gpt-5.6-luna" ? { inputUsdPerMillion: 0.40, outputUsdPerMillion: 1.80 }
    : { inputUsdPerMillion: 4, outputUsdPerMillion: 16 };
  return (estimatedInputTokens * rates.inputUsdPerMillion + maximumOutputTokens * rates.outputUsdPerMillion) / 1_000_000;
}

export function estimateModelInputTokens(body: Record<string, unknown>): number {
  // Byte count conservatively covers content, tool schemas and request overhead instead of assuming four characters per token.
  return Buffer.byteLength(JSON.stringify(body), "utf8") + 64;
}

export type ResearchUpstreamFamily = "GO" | "ZEN" | "OPENROUTER";

export function resolveResearchUpstream(family: ResearchUpstreamFamily, model: string): string {
  if (model === "deepseek/deepseek-v4.1-flash") {
    if (family !== "OPENROUTER") throw new Error("This model requires the OpenRouter route.");
    return "https://openrouter.ai/api/v1/chat/completions";
  }
  if (family === "OPENROUTER") throw new Error(`Unsupported OpenRouter model: ${model}`);
  if (model === "big-pickle" || model === "cat-jam-free" || model === "muse-spark-1.3-contributor-free") {
    if (family !== "ZEN") throw new Error("Free models require the OpenCode Console route.");
    return `https://opencode.ai/inference/v1/${modelUsesResponses(model) ? "responses" : "chat/completions"}`;
  }
  const base = family === "GO" ? "https://opencode.ai/zen/go/v1" : "https://opencode.ai/zen/v1";
  return `${base}/${modelUsesResponses(model) ? "responses" : "chat/completions"}`;
}

export function modelUpstreamBody(body: Record<string, unknown>, family: ResearchUpstreamFamily, model: string): Record<string, unknown> {
  if (family !== "OPENROUTER") return { ...body, model };
  for (const name of ["models", "fallbacks", "route", "plugins", "preset", "provider"]) {
    if (name in body) throw new Error(`OpenRouter ${name} is not allowed by the investigation gateway.`);
  }
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some((tool) => !tool || tool.type !== "function" || !tool.function))) {
    throw new Error("OpenRouter server tools are not allowed by the investigation gateway.");
  }
  // Forward only local function tools and ordinary chat settings; provider features cannot escape capture or budgets.
  const allowed = ["messages", "temperature", "top_p", "frequency_penalty", "presence_penalty", "response_format", "stop", "seed", "tools", "tool_choice", "parallel_tool_calls", "stream", "stream_options", "logit_bias", "logprobs", "top_logprobs"];
  const effort = extractObservedReasoningEffort(body);
  const maximum = Number(body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens ?? 32_000);
  if (!Number.isInteger(maximum) || maximum <= 0) throw new Error("OpenRouter max_tokens must be a positive integer.");
  return { ...Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key))), max_tokens: Math.min(maximum, resolveResearchModel(model).outputLimit), ...(effort ? { reasoning: { effort } } : {}), model };
}

export function sanitizeReasoningEffort(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLocaleLowerCase("en-US");
  return ["low", "medium", "high", "max", "xhigh"].includes(normalized) ? normalized : null;
}

export function extractObservedReasoningEffort(body: Record<string, unknown>): string | null {
  const reasoning = body.reasoning;
  const nestedEffort = reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)
    ? (reasoning as Record<string, unknown>).effort
    : undefined;
  return sanitizeReasoningEffort(body.reasoning_effort ?? body.reasoningEffort ?? nestedEffort);
}

export function modelUpstreamHeaders(key: string, incoming: Record<string, string | string[] | undefined> = {}): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${key}`, "content-type": "application/json" };
  // Preserve the actual OpenCode identity and stable session through the host proxy.
  for (const name of ["user-agent", "x-opencode-session", "x-opencode-project", "x-opencode-version"]) {
    const value = incoming[name];
    if (typeof value === "string" && value.length <= 256) headers[name] = value;
  }
  return headers;
}

export function modelRequestTimeoutMs(remainingMs: number): number {
  return Math.max(1, Math.min(360_000, remainingMs - 15_000));
}

export type ModelRoutePreflight = {
  family: ResearchUpstreamFamily;
  protocol: "CHAT_COMPLETIONS" | "RESPONSES";
  model: string;
  startedAt: string;
  completedAt: string;
  latencyMs: number;
  status: "OK";
};

export async function preflightResearchModel(input: {
  family: ResearchUpstreamFamily;
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<ModelRoutePreflight> {
  if (!input.apiKey) throw new Error(`${input.family === "OPENROUTER" ? "OPENROUTER_API_KEY" : "OPENCODE_API_KEY"} is not configured for model route preflight.`);
  const started = input.now?.() ?? Date.now();
  const startedAt = new Date(started).toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException("Model route preflight timed out.", "TimeoutError")), 15_000);
  try {
    const response = await (input.fetchImpl ?? fetch)(resolveResearchUpstream(input.family, input.model), {
      method: "POST",
      headers: modelUpstreamHeaders(input.apiKey),
      body: JSON.stringify({ model: input.model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 1, stream: false }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Model route preflight returned HTTP ${response.status}.`);
    const completed = input.now?.() ?? Date.now();
    return { family: input.family, protocol: modelUsesResponses(input.model) ? "RESPONSES" : "CHAT_COMPLETIONS", model: input.model, startedAt, completedAt: new Date(completed).toISOString(), latencyMs: Math.max(0, completed - started), status: "OK" };
  } finally {
    clearTimeout(timeout);
  }
}

async function requestUpstream(url: string, headers: Record<string, string>, body: string, signal: AbortSignal): Promise<IncomingMessage> {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new Error("LLM upstream must use HTTPS.");
  return await new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpsRequest(target, { method: "POST", headers, signal, agent: false, timeout: 0 }, resolve);
    request.once("error", reject);
    request.end(body);
  });
}

async function readUpstreamText(upstream: IncomingMessage, maximumBytes?: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of upstream) {
    const bytes = Buffer.from(chunk as Uint8Array);
    const remaining = maximumBytes === undefined ? bytes.length : Math.max(0, maximumBytes - size);
    if (remaining) chunks.push(bytes.subarray(0, remaining));
    size += Math.min(bytes.length, remaining);
    if (maximumBytes !== undefined && size >= maximumBytes) {
      upstream.resume();
      break;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function proxyModelCompletion(input: {
  request: IncomingMessage;
  response: ServerResponse;
  body: Record<string, unknown>;
  agent: string;
  model: string;
  remainingMs?: number;
  providerMode: "fixture" | "live";
  upstreamKey?: string;
  researchUpstreamFamily: ResearchUpstreamFamily;
  fixtureCompletion: () => Promise<Completion>;
}): Promise<void> {
  if (input.providerMode === "fixture") {
    const completion = await input.fixtureCompletion();
    writeFixtureCompletion(input.response, input.body, input.model, completion);
    return;
  }
  if (!input.upstreamKey) throw new Error(`${input.researchUpstreamFamily === "OPENROUTER" ? "OPENROUTER_API_KEY" : "OPENCODE_API_KEY"} is not configured on the host gateway.`);
  const encoded = encodeModelToolNames(input.body);
  const upstreamAbort = new AbortController();
  const timeout = input.remainingMs === undefined
    ? undefined
    : setTimeout(() => upstreamAbort.abort(new DOMException("Model request deadline reached.", "TimeoutError")), modelRequestTimeoutMs(input.remainingMs));
  input.request.once("aborted", () => upstreamAbort.abort(new DOMException("Runtime request disconnected.", "AbortError")));
  input.response.once("close", () => upstreamAbort.abort(new DOMException("Runtime response disconnected.", "AbortError")));
  let upstream: IncomingMessage;
  try {
    upstream = await requestUpstream(
      resolveResearchUpstream(input.researchUpstreamFamily, input.model),
      modelUpstreamHeaders(input.upstreamKey, input.request.headers),
      JSON.stringify(modelUpstreamBody(encoded.body, input.researchUpstreamFamily, input.model)),
      upstreamAbort.signal,
    );
  } catch (error) {
    if (timeout) clearTimeout(timeout);
    throw error;
  }
  const status = upstream.statusCode ?? 502;
  if (status < 200 || status >= 300) {
    let detail = "";
    try { detail = await readUpstreamText(upstream, 2_000); }
    finally { if (timeout) clearTimeout(timeout); }
    const retryAfter = upstream.headers["retry-after"];
    throw new ModelUpstreamError(status, `LLM upstream returned HTTP ${status}: ${detail}`, typeof retryAfter === "string" && /^\d{1,6}$/.test(retryAfter) ? retryAfter : undefined);
  }
  const rawContentType = upstream.headers["content-type"];
  const contentType = Array.isArray(rawContentType) ? rawContentType[0] ?? "application/json" : rawContentType ?? "application/json";
  input.response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (!contentType.includes("text/event-stream")) {
    try {
      const payload = await readUpstreamText(upstream);
      input.response.end(contentType.includes("json") ? decodeJsonToolNames(payload, encoded.wireToSemantic) : payload);
    } finally { if (timeout) clearTimeout(timeout); }
    return;
  }
  const names = new SseToolNameDecoder(encoded.wireToSemantic);
  try {
    for await (const chunk of upstream) {
      const decoded = names.push(Buffer.from(chunk as Uint8Array));
      if (decoded && !input.response.write(decoded)) await new Promise<void>((resolve) => input.response.once("drain", resolve));
    }
    const final = names.flush();
    if (final) input.response.write(final);
  } finally {
    if (timeout) clearTimeout(timeout);
    input.response.end();
  }
}
