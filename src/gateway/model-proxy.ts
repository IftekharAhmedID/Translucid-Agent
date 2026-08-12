import type { IncomingMessage, ServerResponse } from "node:http";

import { prepareFinalizerUpstreamBody } from "../core/finalizer-transport.ts";
import { decodeJsonToolNames, encodeModelToolNames, SseToolNameDecoder } from "./model-tool-names.ts";
import { writeFixtureCompletion, type Completion } from "./fixture-model.ts";

export function modelCostReservation(body: Record<string, unknown>, model: string): number {
  const estimatedInputTokens = estimateModelInputTokens(body);
  const maximumOutputTokens = Math.min(Number(body.max_tokens ?? body.max_completion_tokens ?? 32_000), 384_000);
  const rates = model === "deepseek-v4-pro" || model === "mimo-v2.5-pro"
    ? { input: 0.435, output: 0.87 }
    : { input: 0.14, output: 0.28 };
  return (estimatedInputTokens * rates.input + maximumOutputTokens * rates.output) / 1_000_000;
}

export function estimateModelInputTokens(body: Record<string, unknown>): number {
  return Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
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
  finalizerModel: string;
  finalizerAgents: Set<string>;
  fixtureCompletion: () => Promise<Completion>;
}): Promise<void> {
  if (input.providerMode === "fixture") {
    writeFixtureCompletion(input.response, input.body, input.model, await input.fixtureCompletion());
    return;
  }
  if (!input.upstreamKey) throw new Error("OPENCODE_API_KEY is not configured on the host gateway.");
  const encoded = encodeModelToolNames(input.body);
  const upstreamAbort = new AbortController();
  const timeout = setTimeout(() => upstreamAbort.abort(new DOMException("Investigation deadline reached.", "TimeoutError")), Math.min(input.remainingMs, 300_000));
  input.request.once("aborted", () => upstreamAbort.abort(new DOMException("Runtime request disconnected.", "AbortError")));
  input.response.once("close", () => upstreamAbort.abort(new DOMException("Runtime response disconnected.", "AbortError")));
  let upstream: Response;
  try {
    const finalizer = input.finalizerAgents.has(input.agent);
    const body = finalizer
      ? prepareFinalizerUpstreamBody({ ...encoded.body, model: input.model }, { agent: input.agent, provider: input.finalizerProvider, model: input.finalizerModel })
      : { ...encoded.body, model: input.model };
    upstream = await fetch(finalizer ? input.finalizerUpstreamUrl : input.researchUpstreamUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${input.upstreamKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: upstreamAbort.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
  if (!upstream.ok) {
    const detail = (await upstream.text()).slice(0, 2_000);
    clearTimeout(timeout);
    throw new Error(`LLM upstream returned HTTP ${upstream.status}: ${detail}`);
  }
  input.response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (!upstream.body) { clearTimeout(timeout); return void input.response.end(); }
  const contentType = upstream.headers.get("content-type") ?? "application/json";
  if (!contentType.includes("text/event-stream")) {
    try {
      const payload = await upstream.text();
      input.response.end(contentType.includes("json") ? decodeJsonToolNames(payload, encoded.wireToSemantic) : payload);
    } finally { clearTimeout(timeout); }
    return;
  }
  const reader = upstream.body.getReader();
  const names = new SseToolNameDecoder(encoded.wireToSemantic);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const decoded = names.push(value);
      if (decoded && !input.response.write(decoded)) await new Promise<void>((resolve) => input.response.once("drain", resolve));
    }
    const final = names.flush();
    if (final) input.response.write(final);
  } finally {
    clearTimeout(timeout);
    input.response.end();
    reader.releaseLock();
  }
}
