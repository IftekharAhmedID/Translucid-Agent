import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_RESEARCH_MODEL, MODEL_REGISTRY, resolveResearchModel } from "./model-registry.ts";

test("DeepSeek V4 Pro is the canonical default and Luna is an explicit rollback", () => {
  assert.equal(DEFAULT_RESEARCH_MODEL, "deepseek-v4-pro");
  assert.deepEqual(MODEL_REGISTRY["deepseek-v4-pro"], {
    id: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    protocol: "CHAT_COMPLETIONS",
    variant: "xhigh",
    reasoningEffort: "max",
    contextLimit: 1_000_000,
    outputLimit: 384_000,
    default: true,
  });
  assert.equal(MODEL_REGISTRY["gpt-5.6-luna"]?.protocol, "RESPONSES");
  assert.equal(MODEL_REGISTRY["gpt-5.6-luna"]?.default, false);
});

test("model resolution fails closed for unsupported models", () => {
  assert.equal(resolveResearchModel(undefined).id, "deepseek-v4-pro");
  assert.equal(resolveResearchModel("gpt-5.6-luna").id, "gpt-5.6-luna");
  assert.throws(() => resolveResearchModel("unknown-model"), /Unsupported research model/);
});
