import assert from "node:assert/strict";
import test from "node:test";

import { forcedFinalizationAt } from "./deadlines.ts";

test("research may use the case envelope until the twelve-minute finalization reserve", () => {
  const hardDeadline = new Date("2026-08-09T13:00:00.000Z");

  assert.equal(
    forcedFinalizationAt(hardDeadline, 12 * 60_000).toISOString(),
    "2026-08-09T12:48:00.000Z",
  );
});

test("the reserve must be positive and smaller than the case envelope", () => {
  const hardDeadline = new Date("2026-08-09T13:00:00.000Z");

  assert.throws(() => forcedFinalizationAt(hardDeadline, 0), /reserve/i);
  assert.throws(() => forcedFinalizationAt(hardDeadline, 61 * 60_000, new Date("2026-08-09T12:00:00.000Z")), /reserve/i);
});
