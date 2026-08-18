import assert from "node:assert/strict";
import test from "node:test";

import { HOST_FINALIZATION_RESERVE_MS, RUN_TIMEOUT_MS, researchDeadlineAt } from "./deadlines.ts";

test("normal runs reserve exactly two minutes for deterministic host finalization", () => {
  const total = 1_800_000;
  assert.equal(RUN_TIMEOUT_MS, 1_800_000);
  assert.equal(HOST_FINALIZATION_RESERVE_MS, 120_000);
  assert.equal(researchDeadlineAt(total), 1_680_000);
});
