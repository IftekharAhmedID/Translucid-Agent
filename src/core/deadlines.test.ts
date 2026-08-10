import assert from "node:assert/strict";
import test from "node:test";

import { MAX_RESEARCH_PHASE_MS, researchPhaseDeadline } from "./deadlines.ts";

test("research phase never consumes more than seven and a half minutes of a long case deadline", () => {
  const now = new Date("2026-08-09T12:00:00.000Z");
  const hardDeadline = new Date(now.getTime() + 30 * 60_000);

  assert.equal(MAX_RESEARCH_PHASE_MS, 7.5 * 60_000);
  assert.equal(researchPhaseDeadline(now, hardDeadline).getTime(), now.getTime() + MAX_RESEARCH_PHASE_MS);
});

test("shorter cases preserve one third of available time for critic and adjudicator", () => {
  const now = new Date("2026-08-09T12:00:00.000Z");
  const hardDeadline = new Date(now.getTime() + 6 * 60_000);

  assert.equal(researchPhaseDeadline(now, hardDeadline).getTime(), now.getTime() + 4 * 60_000);
});
