import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";

import { decodeJsonToolNames, encodeModelToolNames, SseToolNameDecoder } from "./model-tool-names.ts";
import { writeFixtureCompletion, type Completion } from "./fixture-model.ts";

export function modelCostReservation(body: Record<string, unknown>, model: string): number {
  const estimatedInputTokens = estimateModelInputTokens(body);
  const maximumOutputTokens = Math.min(Number(body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens ?? 32_000), 384_000);
  void model;
  const rates = { inputUsdPerMillion: 0.14, outputUsdPerMillion: 0.28 };
  return (estimatedInputTokens * rates.inputUsdPerMillion + maximumOutputTokens * rates.outputUsdPerMillion) / 1_000_000;
}

export function estimateModelInputTokens(body: Record<string, unknown>): number {
  return Math.ceil(JSON.stringify(body.messages ?? body.input ?? []).length / 4);
}

export type ResearchUpstreamFamily = "GO" | "ZEN";

export function resolveResearchUpstream(family: ResearchUpstreamFamily, model: string): string {
  const base = family === "GO" ? "https://opencode.ai/zen/go/v1" : "https://opencode.ai/zen/v1";
  return `${base}/${model === "gpt-5.6-luna" ? "responses" : "chat/completions"}`;
}

export function modelUpstreamHeaders(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}

export function modelRequestTimeoutMs(remainingMs: number): number {
  return Math.max(1, Math.min(360_000, remainingMs - 15_000));
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
  if (!input.upstreamKey) throw new Error("OPENCODE_API_KEY is not configured on the host gateway.");
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
      modelUpstreamHeaders(input.upstreamKey),
      JSON.stringify({ ...encoded.body, model: input.model }),
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
