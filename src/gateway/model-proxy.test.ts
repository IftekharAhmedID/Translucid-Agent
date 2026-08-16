import assert from "node:assert/strict";
import test from "node:test";

import { modelCostReservation, modelRequestTimeoutMs, modelUpstreamHeaders } from "./model-proxy.ts";

test("model requests use one bounded timeout with a run-time safety reserve", () => {
  assert.equal(modelRequestTimeoutMs(900_000), 360_000);
  assert.equal(modelRequestTimeoutMs(120_000), 105_000);
  assert.equal(modelRequestTimeoutMs(10_000), 1);
});

test("model cost reservation uses the exact Luna and Flash rates", () => {
  const body = { messages: [{ role: "user", content: "x" }], max_tokens: 1_000 };
  const inputTokens = Math.ceil(JSON.stringify(body.messages).length / 4);
  assert.equal(modelCostReservation(body, "deepseek-v4-flash"), (inputTokens * 0.14 + 1_000 * 0.28) / 1_000_000);
  assert.equal(modelCostReservation(body, "gpt-5.6-luna"), (inputTokens * 0.20 + 1_000 * 1.20) / 1_000_000);
  assert.throws(() => modelCostReservation(body, "unknown-model"), /Unsupported model pricing: unknown-model/);
});

test("upstream headers use the host API key", () => {
  assert.deepEqual(modelUpstreamHeaders("host-secret"), {
    authorization: "Bearer host-secret",
    "content-type": "application/json",
  });
});
