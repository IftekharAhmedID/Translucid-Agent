import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";

import { DEFAULT_MODEL_REQUEST_TIMEOUTS, type ModelRequestTimeouts } from "../core/config.ts";
import { finalizerModelDefinition } from "../core/model-catalog.ts";
import { prepareFinalizerUpstreamBody } from "../core/finalizer-transport.ts";
import { decodeJsonToolNames, encodeModelToolNames, SseToolNameDecoder } from "./model-tool-names.ts";
import { writeAnthropicFixtureCompletion, writeFixtureCompletion, type Completion } from "./fixture-model.ts";

export function modelCostReservation(body: Record<string, unknown>, model: string): number {
  const estimatedInputTokens = estimateModelInputTokens(body);
  const maximumOutputTokens = Math.min(Number(body.max_tokens ?? body.max_completion_tokens ?? 32_000), 384_000);
  const rates = model === "minimax-m3" || model === "mimo-v2.5-pro" || model === "deepseek-v4-pro"
    ? finalizerModelDefinition(model)
    : { inputUsdPerMillion: 0.14, outputUsdPerMillion: 0.28 };
  return (estimatedInputTokens * rates.inputUsdPerMillion + maximumOutputTokens * rates.outputUsdPerMillion) / 1_000_000;
}

export function estimateModelInputTokens(body: Record<string, unknown>): number {
  return Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
}

export function modelUpstreamHeaders(protocol: "OPENAI_CHAT" | "ANTHROPIC_MESSAGES", key: string, anthropicVersion?: string): Record<string, string> {
  return protocol === "ANTHROPIC_MESSAGES"
    ? { "x-api-key": key, "anthropic-version": anthropicVersion ?? "2023-06-01", "content-type": "application/json" }
    : { authorization: `Bearer ${key}`, "content-type": "application/json" };
}

export type ModelRequestStage = "RESEARCH" | "COVERAGE" | "PACKET" | "SUMMARY" | "AUDIT";

export function modelRequestStage(agent: string, body: Record<string, unknown>): ModelRequestStage {
  if (agent === "evidence-auditor" || agent === "evidence-critic" || agent === "fresh-adjudicator") return "AUDIT";
  if (agent !== "evidence-compiler") return "RESEARCH";
  const serialized = JSON.stringify(body.messages ?? body);
  if (serialized.includes("MODE: COVERAGE_ONLY") || serialized.includes("MODE: CLAIM_BATCH") || serialized.includes("MODE: CLAIM_REPAIR")) return "COVERAGE";
  if (serialized.includes("MODE: EVIDENCE_PACKET") || serialized.includes("MODE: EVIDENCE_JUDGE")) return "PACKET";
  if (serialized.includes("MODE: SUMMARY_TIMELINE") || serialized.includes("MODE: SUMMARY")) return "SUMMARY";
  return "SUMMARY";
}

export function modelRequestTimeoutMs(input: {
  agent: string;
  body: Record<string, unknown>;
  remainingMs: number;
  requestTimeouts?: ModelRequestTimeouts;
}): number {
  const timeouts = input.requestTimeouts ?? DEFAULT_MODEL_REQUEST_TIMEOUTS;
  const stage = modelRequestStage(input.agent, input.body);
  const stageLimit = stage === "RESEARCH"
    ? timeouts.researchMs
    : stage === "COVERAGE"
      ? timeouts.coverageMs
      : stage === "PACKET"
        ? timeouts.packetMs
        : stage === "SUMMARY"
          ? timeouts.summaryMs
          : timeouts.auditMs;
  return Math.max(1, Math.min(stageLimit, input.remainingMs - timeouts.safetyReserveMs));
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
  remainingMs: number;
  providerMode: "fixture" | "live";
  upstreamKey?: string;
  researchUpstreamUrl: string;
  finalizerUpstreamUrl: string;
  finalizerProvider: "ZEN" | "GO";
  protocol?: "OPENAI_CHAT" | "ANTHROPIC_MESSAGES";
  finalizerMessagesUpstreamUrl?: string;
  finalizerAgents: Set<string>;
  requestTimeouts?: ModelRequestTimeouts;
  fixtureCompletion: () => Promise<Completion>;
}): Promise<void> {
  if (input.providerMode === "fixture") {
    const completion = await input.fixtureCompletion();
    if (input.protocol === "ANTHROPIC_MESSAGES") writeAnthropicFixtureCompletion(input.response, input.body, input.model, completion);
    else writeFixtureCompletion(input.response, input.body, input.model, completion);
    return;
  }
  if (!input.upstreamKey) throw new Error("OPENCODE_API_KEY is not configured on the host gateway.");
  const encoded = encodeModelToolNames(input.body);
  const upstreamAbort = new AbortController();
  const timeout = setTimeout(() => upstreamAbort.abort(new DOMException("Model request deadline reached.", "TimeoutError")), modelRequestTimeoutMs(input));
  input.request.once("aborted", () => upstreamAbort.abort(new DOMException("Runtime request disconnected.", "AbortError")));
  input.response.once("close", () => upstreamAbort.abort(new DOMException("Runtime response disconnected.", "AbortError")));
  let upstream: IncomingMessage;
  try {
    const finalizer = input.finalizerAgents.has(input.agent);
    const protocol = input.protocol ?? "OPENAI_CHAT";
    const body = finalizer
      ? prepareFinalizerUpstreamBody({ ...encoded.body, model: input.model }, { agent: input.agent, provider: input.finalizerProvider, model: input.model, protocol })
      : { ...encoded.body, model: input.model };
    const upstreamUrl = finalizer && protocol === "ANTHROPIC_MESSAGES"
      ? input.finalizerMessagesUpstreamUrl ?? input.finalizerUpstreamUrl.replace(/\/v1\/chat\/completions$/, "/v1/messages")
      : finalizer ? input.finalizerUpstreamUrl : input.researchUpstreamUrl;
    upstream = await requestUpstream(
      upstreamUrl,
      modelUpstreamHeaders(protocol, input.upstreamKey, typeof input.request.headers["anthropic-version"] === "string" ? input.request.headers["anthropic-version"] : undefined),
      JSON.stringify(body),
      upstreamAbort.signal,
    );
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
  const status = upstream.statusCode ?? 502;
  if (status < 200 || status >= 300) {
    let detail = "";
    try { detail = await readUpstreamText(upstream, 2_000); }
    finally { clearTimeout(timeout); }
    throw new Error(`LLM upstream returned HTTP ${status}: ${detail}`);
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
    } finally { clearTimeout(timeout); }
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
    clearTimeout(timeout);
    input.response.end();
  }
}
