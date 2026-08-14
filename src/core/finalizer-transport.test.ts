import assert from "node:assert/strict";
import test from "node:test";

import { finalizerOutputTransport, prepareFinalizerUpstreamBody } from "./finalizer-transport.ts";

test("GO finalizers use JSON object transport instead of forced tools", () => {
  assert.equal(finalizerOutputTransport("GO", "deepseek-v4-flash"), "JSON_OBJECT");
  assert.equal(finalizerOutputTransport("GO", "opencode-go/deepseek-v4-pro"), "JSON_OBJECT");
  assert.equal(finalizerOutputTransport("GO", "mimo-v2.5-pro"), "JSON_OBJECT");
  assert.equal(finalizerOutputTransport("ZEN", "deepseek-v4-flash"), "JSON_OBJECT");
  assert.equal(finalizerOutputTransport("GO", "glm-5.2"), "JSON_OBJECT");
});

test("finalizer agents receive json_object response format when supported", () => {
  const body = { model: "deepseek-v4-flash", messages: [] };
  assert.deepEqual(
    prepareFinalizerUpstreamBody(body, { agent: "evidence-critic", provider: "GO", model: "deepseek-v4-flash" }),
    { ...body, max_tokens: 16_384, response_format: { type: "json_object" } },
  );
  assert.equal(
    prepareFinalizerUpstreamBody(body, { agent: "lead-investigator", provider: "GO", model: "deepseek-v4-flash" }),
    body,
  );
  assert.deepEqual(
    prepareFinalizerUpstreamBody(body, { agent: "fresh-adjudicator", provider: "ZEN", model: "deepseek-v4-flash" }),
    { ...body, max_tokens: 16_384, response_format: { type: "json_object" } },
  );
  assert.deepEqual(
    prepareFinalizerUpstreamBody(body, { agent: "evidence-compiler", provider: "GO", model: "deepseek-v4-pro" }),
    { ...body, max_tokens: 16_384, response_format: { type: "json_object" } },
  );
  assert.deepEqual(
    prepareFinalizerUpstreamBody(body, { agent: "evidence-auditor", provider: "GO", model: "deepseek-v4-pro" }),
    { ...body, max_tokens: 16_384, response_format: { type: "json_object" } },
  );
  assert.deepEqual(
    prepareFinalizerUpstreamBody({ model: "mimo-v2.5-pro", messages: [] }, { agent: "evidence-compiler", provider: "GO", model: "mimo-v2.5-pro" }),
    { model: "mimo-v2.5-pro", messages: [], max_tokens: 16_384 },
  );
  assert.deepEqual(
    prepareFinalizerUpstreamBody({ model: "minimax-m3", messages: [], max_tokens: 32_000 }, { agent: "evidence-auditor", provider: "ZEN", model: "minimax-m3", protocol: "ANTHROPIC_MESSAGES" }),
    { model: "minimax-m3", messages: [], max_tokens: 16_384 },
  );
});

test("plain-text dossier requests bypass JSON-object compatibility formatting", () => {
  const body = {
    model: "deepseek-v4-pro",
    messages: [{ role: "system", content: "TRANSLUCID_FINALIZER_TEXT_MODE" }],
  };
  assert.deepEqual(
    prepareFinalizerUpstreamBody(body, { agent: "evidence-compiler", provider: "GO", model: "deepseek-v4-pro" }),
    { ...body, max_tokens: 16_384 },
  );
  assert.deepEqual(
    prepareFinalizerUpstreamBody(body, { agent: "evidence-auditor", provider: "GO", model: "deepseek-v4-pro" }),
    { ...body, max_tokens: 16_384 },
  );
});

test("all finalizer transports cap rather than inflate requested output", () => {
  const body = { model: "deepseek-v4-flash", max_tokens: 32_000 };
  assert.equal(
    prepareFinalizerUpstreamBody(body, { agent: "fresh-adjudicator", provider: "GO", model: "deepseek-v4-flash" }).max_tokens,
    16_384,
  );
  assert.equal(
    prepareFinalizerUpstreamBody({ ...body, max_tokens: 1_024 }, { agent: "fresh-adjudicator", provider: "GO", model: "deepseek-v4-flash" }).max_tokens,
    1_024,
  );
  assert.deepEqual(
    prepareFinalizerUpstreamBody({ model: "deepseek-v4-flash", max_completion_tokens: 40_000 }, { agent: "fresh-adjudicator", provider: "GO", model: "deepseek-v4-flash" }),
    { model: "deepseek-v4-flash", max_tokens: 16_384, response_format: { type: "json_object" } },
  );
});
