import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { describeSdkError, driveReportPublishing, publishingPrompt, recoveryPublishingPrompt, readCompletedResearchMemos, waitForResearchIdle } from "./controller.ts";

test("publishing prompt assigns report semantics to the lead and structure to the backend", () => {
  const prompt = recoveryPublishingPrompt();
  assert.match(prompt, /report\.progress\.get/);
  assert.match(prompt, /report\.finding\.upsert/);
  assert.match(prompt, /discarded historical report artifacts/i);
  assert.match(prompt, /no provider/i);
  assert.match(publishingPrompt(), /There is no target count/);
});

test("publishes in the existing lead session with at most two continuation prompts", async () => {
  const prompts: string[] = [];
  let reads = 0;
  const ready = await driveReportPublishing({
    launch: async (prompt) => { prompts.push(prompt); },
    waitUntilIdle: async () => undefined,
    progress: async () => ({
      schemaVersion: 1,
      run: { id: "run-1", inputSha256: "a".repeat(64), startedAt: "2026-08-14T00:00:00.000Z", runtime: "LOCAL", model: "research-model" },
      state: reads++ >= 2 ? "READY" : "OPEN",
      revision: 0,
      summary: "",
      findings: [],
    }),
  });
  assert.equal(ready.state, "READY");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1] ?? "", /report\.progress\.get/);
});

test("fails closed after the bounded publishing continuations", async () => {
  let launches = 0;
  await assert.rejects(driveReportPublishing({
    launch: async () => { launches += 1; },
    waitUntilIdle: async () => undefined,
    progress: async () => ({
      schemaVersion: 1,
      run: { id: "run-1", inputSha256: "a".repeat(64), startedAt: "2026-08-14T00:00:00.000Z", runtime: "LOCAL", model: "research-model" },
      state: "OPEN",
      revision: launches,
      summary: "",
      findings: [],
    }),
  }), /did not finalize/i);
  assert.equal(launches, 3);
});

test("reads completed specialist memos and reports missing snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-memos-"));
  try {
    const memoDirectory = join(root, ".work", "memos");
    await mkdir(memoDirectory, { recursive: true });
    await writeFile(join(memoDirectory, "professional-researcher-child-1.md"), "Session: child-1\n\nCompleted finding [S1].\n");
    const result = await readCompletedResearchMemos(memoDirectory, [
      { id: "child-1", agent: "professional-researcher" },
      { id: "child-2", agent: "github-researcher" },
    ]);
    assert.equal(result.memos.length, 1);
    assert.deepEqual(result.completedSessionIds, new Set(["child-1"]));
    assert.match(result.warnings.join("\n"), /github-researcher.*child-2.*no completed memo/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("waits for an asynchronously prompted session to become idle", async () => {
  const statuses = ["busy", "busy", undefined] as const;
  let index = 0;
  await waitForResearchIdle({
    readStatus: async () => statuses[Math.min(index++, statuses.length - 1)],
    deadlineAt: Date.now() + 1_000,
    signal: new AbortController().signal,
    intervalMs: 0,
  });
  assert.equal(index, 3);
});

test("describes SDK errors with non-enumerable details", () => {
  const error = new Error("upstream request timed out");
  Object.defineProperty(error, "data", { value: { ref: "err_123" }, enumerable: false });
  assert.match(describeSdkError(error), /Error: upstream request timed out/);
  assert.match(describeSdkError(error), /err_123/);
});
