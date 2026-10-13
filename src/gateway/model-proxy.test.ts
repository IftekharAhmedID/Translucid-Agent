import assert from "node:assert/strict";
import test from "node:test";

import { estimateModelInputTokens, modelCostReservation, modelRequestTimeoutMs, modelUpstreamBody, modelUpstreamHeaders, preflightResearchModel, resolveResearchUpstream } from "./model-proxy.ts";

test("OpenRouter uses its approved model and preserves tool requests while normalizing reasoning", () => {
  const model = "deepseek/deepseek-v4.1-flash";
  assert.equal(resolveResearchUpstream("OPENROUTER", model), "https://openrouter.ai/api/v1/chat/completions");
  assert.throws(() => resolveResearchUpstream("GO", model), /OpenRouter route/);
  assert.throws(() => resolveResearchUpstream("ZEN", model), /OpenRouter route/);
  assert.throws(() => resolveResearchUpstream("OPENROUTER", "deepseek-v4-pro"), /Unsupported OpenRouter model/);
  const body = { messages: [{ role: "user", content: "Investigate" }], reasoning_effort: "medium", tools: [{ type: "function", function: { name: "research" } }], stream: true };
  assert.deepEqual(modelUpstreamBody(body, "OPENROUTER", model), { messages: body.messages, tools: body.tools, stream: true, max_tokens: 32000, reasoning: { effort: "medium" }, model });
  assert.equal(body.reasoning_effort, "medium");
  assert.deepEqual(modelUpstreamBody(body, "GO", "deepseek-v4-pro"), { ...body, model: "deepseek-v4-pro" });
  assert.equal(modelCostReservation({ max_tokens: 1000 }, model), (estimateModelInputTokens({ max_tokens: 1000 }) * 0.30 + 1000 * 1.20) / 1_000_000);
});

test("OpenRouter cannot invoke routing overrides, paid plugins, or server tools", () => {
  const model = "deepseek/deepseek-v4.1-flash";
  const base = { messages: [], reasoning_effort: "medium" };
  for (const override of [{ models: ["unapproved"] }, { plugins: [{ id: "web" }] }, { preset: "external" }, { route: "fallback" }, { provider: { order: ["external"] } }, { tools: [{ type: "web_search" }] }]) {
    assert.throws(() => modelUpstreamBody({ ...base, ...override }, "OPENROUTER", model), /not allowed/);
  }
  for (const effort of [{ reasoning_effort: " MEDIUM " }, { reasoningEffort: "Medium" }, { reasoning: { effort: "medium", enabled: false } }]) {
    assert.deepEqual(modelUpstreamBody({ messages: [], ...effort }, "OPENROUTER", model).reasoning, { effort: "medium" });
  }
  assert.equal(modelUpstreamBody({ ...base, max_tokens: 943718, n: 10 }, "OPENROUTER", model).max_tokens, 384000);
  assert.equal(modelUpstreamBody({ ...base, n: 10 }, "OPENROUTER", model).n, undefined);
  assert.equal(modelUpstreamBody({ ...base, max_output_tokens: 1 }, "OPENROUTER", model).max_tokens, 1);
});

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
