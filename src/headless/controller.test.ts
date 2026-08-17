import assert from "node:assert/strict";
import test from "node:test";

import { canPublishAfterResearchFailure, classifyInvestigationFailure, driveReportPublishing, InvestigationStallError, publishingPrompt, waitForResearchIdle } from "./controller.ts";

test("publishing starts by persisting explicit claim state and never enables providers", () => {
  const prompt = publishingPrompt();
  assert.match(prompt, /research\.state\.set/);
  assert.match(prompt, /SEARCH_DISCOVERY/);
  assert.match(prompt, /report\.finalize/);
  assert.match(prompt, /External provider tools are disabled/i);
});

test("publishes with one bounded continuation", async () => {
  const prompts: string[] = [];
  let reads = 0;
  const ready = await driveReportPublishing({
    launch: async (prompt) => { prompts.push(prompt); },
    waitUntilIdle: async () => undefined,
    progress: async () => ({
      schemaVersion: 1,
      run: { id: "run-1", inputSha256: "a".repeat(64), startedAt: "2026-08-14T00:00:00.000Z", runtime: "LOCAL", model: "gpt-5.6-luna" },
      state: reads++ >= 2 ? "READY" : "OPEN",
      revision: 0,
      summary: "",
      findings: [],
    }),
  });
  assert.equal(ready.state, "READY");
  assert.equal(prompts.length, 2);
});

test("fails closed after the single publishing continuation", async () => {
  let launches = 0;
  await assert.rejects(driveReportPublishing({
    launch: async () => { launches += 1; },
    waitUntilIdle: async () => undefined,
    progress: async () => ({
      schemaVersion: 1,
      run: { id: "run-1", inputSha256: "a".repeat(64), startedAt: "2026-08-14T00:00:00.000Z", runtime: "LOCAL", model: "gpt-5.6-luna" },
      state: "OPEN",
      revision: launches,
      summary: "",
      findings: [],
    }),
  }), /one bounded continuation/i);
  assert.equal(launches, 2);
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

test("classifies cancellation and ordinary failures without specialist handoff states", () => {
  assert.deepEqual(classifyInvestigationFailure(new Error("cancelled"), true, true), { code: "CANCELLED_OR_TIMED_OUT", phase: "INVESTIGATION" });
  assert.deepEqual(classifyInvestigationFailure(new Error("provider failed"), false, true), { code: "INVESTIGATION_FAILED", phase: "INVESTIGATION" });
});

test("only publishes after a stalled research stage when valid claim state already exists", () => {
  const stalled = new InvestigationStallError("RESEARCH", "no progress");
  assert.equal(canPublishAfterResearchFailure(stalled, false), false);
  assert.equal(canPublishAfterResearchFailure(stalled, true), true);
  assert.equal(canPublishAfterResearchFailure(new Error("deadline"), false), true);
});
