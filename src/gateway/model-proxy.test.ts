import assert from "node:assert/strict";
import test from "node:test";

import { modelCostReservation, modelRequestTimeoutMs, modelUpstreamHeaders } from "./model-proxy.ts";

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

test("upstream headers use the host API key", () => {
  assert.deepEqual(modelUpstreamHeaders("host-secret"), {
    authorization: "Bearer host-secret",
    "content-type": "application/json",
  });
});
