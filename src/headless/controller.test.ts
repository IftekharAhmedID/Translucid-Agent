import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";

import { readFile } from "node:fs/promises";

import { canPublishAfterResearchFailure, classifyInvestigationFailure, HeadlessInvestigationController, InvestigationStallError, ResearchDeadlineError, waitForResearchIdle } from "./controller.ts";
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


test("synthesis recovery acknowledges asynchronously and waits for the durable commit", async () => {
  let launches = 0;
  let polls = 0;
  let committed = false;
  let materialized = false;
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* drain the SDK request */ }
    response.setHeader("content-type", "application/json");
    if (request.url?.includes("/prompt_async")) {
      launches++; polls = 0; response.writeHead(204); response.end();
    } else if (request.url?.includes("/message")) {
      // A blocking prompt can time out while the investigator is still working.
      response.writeHead(504); response.end(JSON.stringify({ error: "HeadersTimeoutError" }));
    } else if (request.url?.includes("/status")) {
      if (++polls === 1) response.end(JSON.stringify({ lead: { type: "busy" } }));
      else { if (launches === 2) committed = true; response.end("{}"); }
    } else {
      response.end(JSON.stringify({ id: "lead", agent: "lead-researcher", model: { id: "deepseek-v4.1-flash", providerID: "translucid" } }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const result = { runId: "test-commit" };
    const output = await new HeadlessInvestigationController().run({
      root: "/unused", handle: { kind: "E2B", id: "test", openCodeUrl: `http://127.0.0.1:${address.port}`, manifestHash: "test" },
      signal: new AbortController().signal, runtime: "E2B", researchModel: "deepseek-v4.1-flash", researchVariant: "medium",
      researchState: { current: async () => ({ schemaVersion: 3, phase: committed ? "COMMITTED" : "RESEARCHING" }) } as never,
      reportStore: { materializeV3: async () => { assert.equal(committed, true); materialized = true; }, result: async () => result } as never,
      sourceStore: {} as never, activity: { lastProgressAt: Date.now() },
      persistResearchSnapshot: async () => { assert.equal(committed, true); return "snapshot"; }, bindResearchSnapshot: () => undefined,
    });
    assert.equal(launches, 2);
    assert.equal(materialized, true);
    assert.equal(output.result, result);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
