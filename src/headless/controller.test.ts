import assert from "node:assert/strict";
import test from "node:test";

import { readFile } from "node:fs/promises";

import { canPublishAfterResearchFailure, classifyInvestigationFailure, InvestigationStallError, ResearchDeadlineError, waitForResearchIdle } from "./controller.ts";
import { researchPrompt } from "./prompt-contracts.ts";

test("controller uses one lead session and deterministic v3 materialization", async () => {
  const source = await readFile(new URL("./controller.ts", import.meta.url), "utf8");
  assert.match(source, /materializeV3/);
  assert.match(source, /synthesisRecoveryPrompt/);
  assert.doesNotMatch(source, /createOpenCodeStructuredWriter/);
  assert.doesNotMatch(source, /finalizeFrozenResearch/);
  assert.doesNotMatch(source, /report-writer/);
  assert.doesNotMatch(source, /report\.finalize/);
});

test("compact-context rescue prompting prioritizes synthesis and commit without changing the default prompt", () => {
  const normal = researchPrompt("2026-08-18T23:42:30.366Z");
  const compact = researchPrompt("2026-08-18T23:42:30.366Z", { compactContext: true });
  assert.doesNotMatch(normal, /compact-context rescue/i);
  assert.match(compact, /compact-context rescue/i);
  assert.match(compact, /do not start another broad search wave/i);
  assert.match(compact, /investigation\.synthesis\.begin/i);
  assert.match(compact, /investigation\.commit/i);
});

test("stops a busy session after meaningful progress stalls", async () => {
  const signal = new AbortController().signal;
  await assert.rejects(waitForResearchIdle({
    readStatus: async () => "busy",
    deadlineAt: 1_000_000,
    signal,
    intervalMs: 0,
    now: (() => { let value = 0; return () => value += 181_000; })(),
    readActivity: () => ({ lastProgressAt: 0, modelStartedAt: undefined }),
  }), /meaningful progress/i);
});

test("does not wait through the startup grace after a model has completed", async () => {
  let now = 0;
  await waitForResearchIdle({
    readStatus: async () => undefined,
    deadlineAt: 100_000,
    signal: new AbortController().signal,
    intervalMs: 0,
    now: () => now += 100,
    initialGraceMs: 30_000,
    readActivity: () => ({ lastProgressAt: 1, modelStartedAt: undefined }),
  });
});

test("qualification waiting has no deadline or liveness enforcement", async () => {
  let attempts = 0;
  await waitForResearchIdle({
    readStatus: async () => ++attempts === 1 ? "busy" : undefined,
    signal: new AbortController().signal,
    intervalMs: 0,
    now: (() => { let value = 0; return () => value += 1_000_000; })(),
    readActivity: () => ({ lastProgressAt: 0, modelStartedAt: 0 }),
  });
});

test("classifies cancellation and ordinary failures without specialist handoff states", () => {
  assert.deepEqual(classifyInvestigationFailure(new Error("cancelled"), true, true), { code: "CANCELLED_OR_TIMED_OUT", phase: "INVESTIGATION" });
  assert.deepEqual(classifyInvestigationFailure(new Error("provider failed"), false, true), { code: "INVESTIGATION_FAILED", phase: "INVESTIGATION" });
});

test("only whitelisted research termination can publish with a ready ledger", () => {
  const stalled = new InvestigationStallError("RESEARCH", "no progress");
  assert.equal(canPublishAfterResearchFailure(stalled, false), false);
  assert.equal(canPublishAfterResearchFailure(stalled, true), true);
  assert.equal(canPublishAfterResearchFailure(new ResearchDeadlineError(), true), true);
  assert.equal(canPublishAfterResearchFailure(new Error("provider integrity failure"), true), false);
  assert.equal(canPublishAfterResearchFailure(undefined, true), true);
});
