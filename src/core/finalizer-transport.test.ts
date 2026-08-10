import assert from "node:assert/strict";
import test from "node:test";

import { finalizerOutputTransport, prepareFinalizerUpstreamBody } from "./finalizer-transport.ts";

test("GO DeepSeek V4 finalizers use JSON object transport instead of forced tools", () => {
  assert.equal(finalizerOutputTransport("GO", "deepseek-v4-flash"), "JSON_OBJECT");
  assert.equal(finalizerOutputTransport("GO", "opencode-go/deepseek-v4-pro"), "JSON_OBJECT");
  assert.equal(finalizerOutputTransport("ZEN", "deepseek-v4-flash"), "NATIVE_JSON_SCHEMA");
  assert.equal(finalizerOutputTransport("GO", "glm-5.2"), "NATIVE_JSON_SCHEMA");
});

test("only GO DeepSeek finalizer agents receive json_object response format", () => {
  const body = { model: "deepseek-v4-flash", messages: [] };
  assert.deepEqual(
    prepareFinalizerUpstreamBody(body, { agent: "evidence-critic", provider: "GO", model: "deepseek-v4-flash" }),
    { ...body, max_tokens: 16_384, response_format: { type: "json_object" } },
  );
  assert.equal(
    prepareFinalizerUpstreamBody(body, { agent: "lead-investigator", provider: "GO", model: "deepseek-v4-flash" }),
    body,
  );
  assert.equal(
    prepareFinalizerUpstreamBody(body, { agent: "fresh-adjudicator", provider: "ZEN", model: "deepseek-v4-flash" }),
    body,
  );
});

test("GO finalizers preserve a larger requested output allowance", () => {
  const body = { model: "deepseek-v4-flash", max_tokens: 32_000 };
  assert.equal(
    prepareFinalizerUpstreamBody(body, { agent: "fresh-adjudicator", provider: "GO", model: "deepseek-v4-flash" }).max_tokens,
    32_000,
  );
});
