import assert from "node:assert/strict";
import test from "node:test";

import { estimateModelInputTokens, modelCostReservation, modelRequestTimeoutMs, modelUpstreamHeaders, resolveResearchUpstream } from "./model-proxy.ts";

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

test("research upstream resolution keeps Luna on Responses and compatible models on Chat Completions", () => {
  assert.equal(resolveResearchUpstream("GO", "gpt-5.6-luna"), "https://opencode.ai/zen/go/v1/responses");
  assert.equal(resolveResearchUpstream("GO", "deepseek-v4-flash"), "https://opencode.ai/zen/go/v1/chat/completions");
  assert.equal(resolveResearchUpstream("ZEN", "gpt-5.6-luna"), "https://opencode.ai/zen/v1/responses");
  assert.equal(resolveResearchUpstream("ZEN", "deepseek-v4-flash"), "https://opencode.ai/zen/v1/chat/completions");
});

test("upstream headers use the host API key", () => {
  assert.deepEqual(modelUpstreamHeaders("host-secret"), {
    authorization: "Bearer host-secret",
    "content-type": "application/json",
  });
});
