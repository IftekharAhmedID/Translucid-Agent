import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_MODEL_REQUEST_TIMEOUTS, type ModelRequestTimeouts } from "../core/config.ts";
import { modelCostReservation, modelRequestStage, modelRequestTimeoutMs, modelUpstreamHeaders } from "./model-proxy.ts";

const timeouts: ModelRequestTimeouts = {
  researchMs: 360_000,
  coverageMs: 480_000,
  packetMs: 600_000,
  summaryMs: 360_000,
  auditMs: 600_000,
  safetyReserveMs: 15_000,
};

test("model requests are classified by finalization stage", () => {
  assert.equal(modelRequestStage("professional-researcher", {}), "RESEARCH");
  assert.equal(modelRequestStage("evidence-compiler", { messages: [{ role: "user", content: "MODE: COVERAGE_ONLY" }] }), "COVERAGE");
  assert.equal(modelRequestStage("evidence-compiler", { messages: [{ role: "user", content: "MODE: EVIDENCE_PACKET" }] }), "PACKET");
  assert.equal(modelRequestStage("evidence-compiler", { messages: [{ role: "user", content: "MODE: SUMMARY_TIMELINE" }] }), "SUMMARY");
  assert.equal(modelRequestStage("evidence-auditor", {}), "AUDIT");
});

test("stage-aware timeout is capped by both stage budget and remaining run time", () => {
  assert.equal(modelRequestTimeoutMs({ agent: "evidence-compiler", body: { messages: [{ role: "user", content: "MODE: EVIDENCE_PACKET" }] }, remainingMs: 900_000, requestTimeouts: timeouts }), 600_000);
  assert.equal(modelRequestTimeoutMs({ agent: "evidence-compiler", body: { messages: [{ role: "user", content: "MODE: EVIDENCE_PACKET" }] }, remainingMs: 120_000, requestTimeouts: timeouts }), 105_000);
  assert.equal(modelRequestTimeoutMs({ agent: "professional-researcher", body: {}, remainingMs: 10_000, requestTimeouts: timeouts }), 1);
  assert.deepEqual(DEFAULT_MODEL_REQUEST_TIMEOUTS, timeouts);
});

test("MiniMax M3 uses the documented catalog rate", () => {
  const body = { messages: [{ role: "user", content: "x" }], max_tokens: 1_000 };
  assert.equal(modelCostReservation(body, "minimax-m3"), (Math.ceil(JSON.stringify(body.messages).length / 4) * 0.30 + 1_000 * 1.20) / 1_000_000);
});

test("Anthropic Messages forwards the host credential as an API key", () => {
  assert.deepEqual(modelUpstreamHeaders("ANTHROPIC_MESSAGES", "host-secret", "2023-06-01"), {
    "x-api-key": "host-secret",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  });
  assert.deepEqual(modelUpstreamHeaders("OPENAI_CHAT", "host-secret"), {
    authorization: "Bearer host-secret",
    "content-type": "application/json",
  });
});
