import assert from "node:assert/strict";
import test from "node:test";

import { estimateModelInputTokens, modelCostReservation, modelRequestTimeoutMs, modelUpstreamHeaders, preflightResearchModel, resolveResearchUpstream } from "./model-proxy.ts";

test("model requests use one bounded timeout with a run-time safety reserve", () => {
  assert.equal(modelRequestTimeoutMs(900_000), 360_000);
  assert.equal(modelRequestTimeoutMs(120_000), 105_000);
  assert.equal(modelRequestTimeoutMs(10_000), 1);
});

test("model cost reservation is model-agnostic during publishing", () => {
  const body = { messages: [{ role: "user", content: "x" }], max_tokens: 1_000 };
  const expected = (Math.ceil(JSON.stringify(body.messages).length / 4) * 0.14 + 1_000 * 0.28) / 1_000_000;
  assert.equal(modelCostReservation(body, "any-lead-model"), expected);
});

test("Responses accounting accepts input and max_output_tokens", () => {
  const body = { input: [{ role: "user", content: "response input" }], max_output_tokens: 2_000 };
  const expected = (Math.ceil(JSON.stringify(body.input).length / 4) * 0.14 + 2_000 * 0.28) / 1_000_000;
  assert.equal(estimateModelInputTokens(body), Math.ceil(JSON.stringify(body.input).length / 4));
  assert.equal(modelCostReservation(body, "gpt-5.6-luna"), expected);
});

test("research upstream resolution follows the canonical model registry", () => {
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
