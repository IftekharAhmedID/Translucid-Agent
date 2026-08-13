import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { FINALIZER_MODEL_CATALOG, PAID_GO_MODEL_IDS, PAID_GO_MODEL_SET, finalizerModelDefinition } from "./model-catalog.ts";
import { modelCostReservation } from "../gateway/model-proxy.ts";

test("paid Go catalog includes the supported MiMo V2.5 Pro finalizer and excludes free models", () => {
  assert.ok(PAID_GO_MODEL_SET.has("mimo-v2.5-pro"));
  assert.ok(!PAID_GO_MODEL_SET.has("mimo-v2.5"));
  assert.ok(!PAID_GO_MODEL_SET.has("mimo-v2.5-free"));
  assert.equal(PAID_GO_MODEL_IDS.includes("mimo-v2.5-pro"), true);
});

test("MiMo V2.5 Pro uses the documented Go reservation", () => {
  const body = { messages: [{ role: "user", content: "x" }], max_tokens: 1_000 };
  assert.ok(modelCostReservation(body, "mimo-v2.5-pro") > 0);
  assert.equal(modelCostReservation(body, "mimo-v2.5-pro"), modelCostReservation(body, "deepseek-v4-pro"));
});

test("finalizer catalog describes protocol, limits, and price for benchmark candidates", () => {
  assert.deepEqual(FINALIZER_MODEL_CATALOG.map(({ id }) => id), ["minimax-m3", "mimo-v2.5-pro", "deepseek-v4-pro"]);
  assert.equal(finalizerModelDefinition("minimax-m3").protocol, "ANTHROPIC_MESSAGES");
  assert.equal(finalizerModelDefinition("minimax-m3").upstreamPath, "/v1/messages");
  assert.equal(finalizerModelDefinition("mimo-v2.5-pro").protocol, "OPENAI_CHAT");
  assert.equal(finalizerModelDefinition("deepseek-v4-pro").inputUsdPerMillion, 0.435);
  assert.throws(() => finalizerModelDefinition("unknown"), /Unsupported finalizer model/);
});

test("document vision uses the paid MiMo model in both OpenCode runtimes", async () => {
  for (const runtime of ["runtime/headless-opencode", "runtime/opencode"]) {
    const agent = await readFile(join(process.cwd(), runtime, "agents", "document-vision.md"), "utf8");
    assert.match(agent, /^model: translucid\/mimo-v2\.5-pro$/m, runtime);
    assert.doesNotMatch(agent, /mimo-v2\.5-free/);
    const config = JSON.parse(await readFile(join(process.cwd(), runtime, "opencode.json"), "utf8")) as { provider?: { translucid?: { models?: Record<string, unknown> } } };
    assert.ok(config.provider?.translucid?.models?.["mimo-v2.5-pro"], runtime);
    assert.equal(config.provider?.translucid?.models?.["mimo-v2.5-free"], undefined, runtime);
  }
});
