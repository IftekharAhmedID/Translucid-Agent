import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_RESEARCH_MODEL, MODEL_REGISTRY, resolveResearchModel } from "./model-registry.ts";

test("DeepSeek V4 Pro is the canonical default and Luna is an explicit rollback", () => {
  assert.equal(DEFAULT_RESEARCH_MODEL, "deepseek-v4-pro");
  assert.deepEqual(MODEL_REGISTRY["deepseek-v4-pro"], {
    id: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    protocol: "CHAT_COMPLETIONS",
    variant: "medium",
    reasoningEffort: "medium",
    effectiveReasoningEffort: "high",
    contextLimit: 1_000_000,
    outputLimit: 384_000,
    default: true,
  });
  assert.equal(MODEL_REGISTRY["gpt-5.6-luna"]?.protocol, "RESPONSES");
  assert.equal(MODEL_REGISTRY["gpt-5.6-luna"]?.default, false);
});

test("model resolution fails closed for unsupported models", () => {
  assert.equal(resolveResearchModel(undefined).id, "deepseek-v4-pro");
  assert.deepEqual(resolveResearchModel(undefined), MODEL_REGISTRY["deepseek-v4-pro"]);
  assert.equal(resolveResearchModel("deepseek-v4-pro", "xhigh").reasoningEffort, "max");
  assert.equal(resolveResearchModel("gpt-5.6-luna").id, "gpt-5.6-luna");
  assert.throws(() => resolveResearchModel("gpt-5.6-luna", "medium"), /does not support/i);
  assert.throws(() => resolveResearchModel("unknown-model"), /Unsupported research model/);
});

test("checked-in OpenCode config contains every registry model and the canonical default", async () => {
  const config = JSON.parse(await readFile(join(process.cwd(), "runtime", "headless-opencode", "opencode.json"), "utf8")) as {
    model?: string;
    small_model?: string;
    provider?: { translucid?: { models?: Record<string, { variants?: Record<string, { reasoningEffort?: string }> }> } };
  };
  assert.equal(config.model, "translucid/" + DEFAULT_RESEARCH_MODEL);
  assert.equal(config.small_model, "translucid/" + DEFAULT_RESEARCH_MODEL);
  for (const spec of Object.values(MODEL_REGISTRY)) {
    const runtime = config.provider?.translucid?.models?.[spec.id];
    assert.ok(runtime, "Missing runtime model " + spec.id);
    assert.equal(runtime?.variants?.[spec.variant]?.reasoningEffort, spec.reasoningEffort);
  }
});
