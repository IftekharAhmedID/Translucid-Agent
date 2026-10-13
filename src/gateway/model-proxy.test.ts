import assert from "node:assert/strict";
import test from "node:test";

import { estimateModelInputTokens, modelCostReservation, modelRequestTimeoutMs, modelUpstreamHeaders, preflightResearchModel, resolveResearchUpstream } from "./model-proxy.ts";

test("model requests use one bounded timeout with a run-time safety reserve", () => {
  assert.equal(modelRequestTimeoutMs(900_000), 360_000);
  assert.equal(modelRequestTimeoutMs(120_000), 105_000);
  assert.equal(modelRequestTimeoutMs(10_000), 1);
});

test("paid model reservations use conservative peak rates and free routes reserve zero", () => {
  const body = { messages: [{ role: "user", content: "x" }], max_tokens: 1_000 };
  const expected = ((Buffer.byteLength(JSON.stringify(body)) + 64) * 1.32 + 1_000 * 3.96) / 1_000_000;
  assert.equal(modelCostReservation(body, "deepseek-v4-pro"), expected);
  assert.equal(modelCostReservation(body, "cat-jam-free"), 0);
  assert.equal(modelCostReservation(body, "big-pickle"), 0);
  assert.equal(modelCostReservation(body, "muse-spark-1.3-contributor-free"), 0);
});

test("Responses accounting accepts input and max_output_tokens", () => {
  const body = { input: [{ role: "user", content: "response input" }], max_output_tokens: 2_000 };
  const expected = ((Buffer.byteLength(JSON.stringify(body)) + 64) * 0.40 + 2_000 * 1.80) / 1_000_000;
  assert.equal(estimateModelInputTokens(body), Buffer.byteLength(JSON.stringify(body)) + 64);
  assert.equal(modelCostReservation(body, "gpt-5.6-luna"), expected);
});

test("research upstream resolution follows the canonical model registry", () => {
  assert.equal(resolveResearchUpstream("ZEN", "muse-spark-1.3-contributor-free"), "https://opencode.ai/inference/v1/responses");
  assert.throws(() => resolveResearchUpstream("GO", "muse-spark-1.3-contributor-free"), /Console route/);
  assert.equal(resolveResearchUpstream("GO", "gpt-5.6-luna"), "https://opencode.ai/zen/go/v1/responses");
  assert.equal(resolveResearchUpstream("GO", "deepseek-v4-pro"), "https://opencode.ai/zen/go/v1/chat/completions");
  assert.equal(resolveResearchUpstream("ZEN", "gpt-5.6-luna"), "https://opencode.ai/zen/v1/responses");
  assert.equal(resolveResearchUpstream("ZEN", "deepseek-v4-pro"), "https://opencode.ai/zen/v1/chat/completions");
  assert.throws(() => resolveResearchUpstream("GO", "unsupported-model"), /Unsupported research model/);
});

test("upstream headers use the host API key", () => {
  assert.deepEqual(modelUpstreamHeaders("host-secret"), {
    authorization: "Bearer host-secret",
    "content-type": "application/json",
  });
});

test("the proxy preserves genuine OpenCode session identity without forwarding case credentials", () => {
  assert.deepEqual(modelUpstreamHeaders("host-key", { "user-agent": "opencode/1.18.18", "x-opencode-session": "session-1", authorization: "Bearer private-case-token", cookie: "private" }), {
    authorization: "Bearer host-key", "content-type": "application/json", "user-agent": "opencode/1.18.18", "x-opencode-session": "session-1",
  });
});

test("model route preflight probes only the canonical DeepSeek chat route", async () => {
  let request: RequestInit | undefined;
  const result = await preflightResearchModel({
    family: "GO",
    model: "deepseek-v4-pro",
    apiKey: "secret",
    now: (() => { let value = 1_000; return () => value += 25; })(),
    fetchImpl: async (_url, init) => { request = init; return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 }); },
  });
  assert.equal(result.model, "deepseek-v4-pro");
  assert.equal(result.protocol, "CHAT_COMPLETIONS");
  assert.equal(result.family, "GO");
  assert.equal(result.latencyMs, 25);
  assert.deepEqual(JSON.parse(String(request?.body)), { model: "deepseek-v4-pro", messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 1, stream: false });
});

test("model route preflight fails closed for missing credentials and upstream errors", async () => {
  await assert.rejects(() => preflightResearchModel({ family: "GO", model: "deepseek-v4-pro" }), /OPENCODE_API_KEY/);
  await assert.rejects(() => preflightResearchModel({ family: "GO", model: "deepseek-v4-pro", apiKey: "secret", fetchImpl: async () => new Response("no", { status: 503 }) }), /HTTP 503/);
});
