import assert from "node:assert/strict";
import test from "node:test";

import { PAID_GO_MODEL_IDS, PAID_GO_MODEL_SET } from "./model-catalog.ts";
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
