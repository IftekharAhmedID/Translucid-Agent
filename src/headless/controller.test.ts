import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { auditingPrompt, classifyInvestigationFailure, describeSdkError, draftingPrompt, driveReportPublishing, publishingPrompt, recoveryPublishingPrompt, readCompletedResearchMemos, ResearchHandoffError, waitForResearchIdle } from "./controller.ts";

async function writeAcceptedMemo(memoDirectory: string, role: string, sessionId: string, memo: string, filePrefix = `${role}-${sessionId}`): Promise<void> {
  const ledgerDirectory = join(memoDirectory, "..", "evidence-ledgers");
  await mkdir(ledgerDirectory, { recursive: true });
  const ledgerPath = `.work/evidence-ledgers/${role}-${sessionId}.json`;
  const ledger = JSON.stringify({ schemaVersion: 1, role, sessionId, encounteredSourceRefs: ["S1"], entries: [{ sourceRef: "S1", disposition: "EVIDENCE", relevance: "test", sourceFamily: "fixture", claimLane: "test" }] }, null, 2) + "\n";
  await writeFile(join(ledgerDirectory, `${role}-${sessionId}.json`), ledger);
  await writeFile(join(memoDirectory, `${filePrefix}.md`), memo);
  await writeFile(join(memoDirectory, `${filePrefix}.sources.json`), JSON.stringify({ schemaVersion: 2, role, sessionId, memoSha256: createHash("sha256").update(memo).digest("hex"), encounteredSourceRefs: ["S1"], citedSourceRefs: ["S1"], ledgerPath, ledgerSha256: createHash("sha256").update(ledger).digest("hex"), ledgerEntryCount: 1 }));
}

test("publishing prompt assigns report semantics to the lead and structure to the backend", () => {
  const prompt = recoveryPublishingPrompt();
  assert.match(prompt, /report\.progress\.get/);
  assert.match(prompt, /report\.finding\.upsert/);
  assert.match(prompt, /discarded historical report artifacts/i);
  assert.match(prompt, /no provider/i);
  assert.match(draftingPrompt(), /There is no target count/);
  assert.match(draftingPrompt(), /Do not call report\.finalize/i);
  assert.match(auditingPrompt(), /Challenge every status 2/i);
  assert.equal(publishingPrompt(), draftingPrompt());
});

test("drafts and audits in separate bounded turns", async () => {
  const prompts: string[] = [];
  const phases: string[] = [];
  let reads = 0;
  const ready = await driveReportPublishing({
    launch: async (prompt) => { prompts.push(prompt); },
    beginDrafting: () => { phases.push("DRAFTING"); },
    beginAuditing: () => { phases.push("AUDITING"); },
    waitUntilIdle: async () => undefined,
    progress: async () => {
      const current = reads++;
      return {
        schemaVersion: 1,
        run: { id: "run-1", inputSha256: "a".repeat(64), startedAt: "2026-08-14T00:00:00.000Z", runtime: "LOCAL", model: "research-model" },
        state: current >= 3 ? "READY" : "OPEN",
        revision: current,
        summary: current >= 2 ? "Summary" : "",
        findings: current >= 2 ? [{} as never] : [],
      };
    },
  });
  assert.equal(ready.state, "READY");
  assert.equal(prompts.length, 3);
  assert.match(prompts[0] ?? "", /draft/i);
  assert.match(prompts[1] ?? "", /Continue drafting/i);
  assert.match(prompts[2] ?? "", /adversarial audit/i);
  assert.deepEqual(phases, ["DRAFTING", "AUDITING"]);
});

test("fails closed after bounded drafting prompts", async () => {
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
  }), /structurally complete report draft/i);
  assert.equal(launches, 2);
});

test("fails the handoff for every launched child session without exactly one accepted memo", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-memos-"));
  try {
    const memoDirectory = join(root, ".work", "memos");
    await mkdir(memoDirectory, { recursive: true });
    await writeAcceptedMemo(memoDirectory, "professional-researcher", "child-1", "# professional-researcher memo\n\nSession: child-1\n\nCompleted finding [S1].\n");
    const children = [
      { id: "child-1", agent: "professional-researcher" },
      { id: "child-2", agent: "professional-researcher" },
      { id: "vision-1", agent: "document-vision" },
    ];
    await assert.rejects(readCompletedResearchMemos(memoDirectory, children), (error: unknown) => {
      assert.ok(error instanceof ResearchHandoffError);
      assert.equal(error.code, "RESEARCH_HANDOFF_FAILED");
      assert.equal(error.phase, "RESEARCH_HANDOFF");
      assert.deepEqual(error.failures, [{ sessionId: "child-2", role: "professional-researcher", acceptedMemoCount: 0 }]);
      return true;
    });

    await writeAcceptedMemo(memoDirectory, "professional-researcher", "child-2", "# professional-researcher memo\n\nSession: child-2\n\nSearch completed with no credible public evidence.\n");
    const result = await readCompletedResearchMemos(memoDirectory, children);
    assert.equal(result.memos.length, 2);
    assert.deepEqual(result.completedSessionIds, new Set(["child-1", "child-2"]));

    await writeAcceptedMemo(memoDirectory, "professional-researcher", "child-2", "# professional-researcher memo\n\nSession: child-2\n\nDuplicate handoff.\n", "duplicate-child-2");
    await assert.rejects(readCompletedResearchMemos(memoDirectory, children), (error: unknown) => {
      assert.ok(error instanceof ResearchHandoffError);
      assert.deepEqual(error.failures, [{ sessionId: "child-2", role: "professional-researcher", acceptedMemoCount: 2 }]);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("typed research handoff failures override generic investigation failure classification", () => {
  const error = new ResearchHandoffError([{ sessionId: "child-2", role: "github-researcher", acceptedMemoCount: 0 }]);
  assert.deepEqual(classifyInvestigationFailure(error, false, true), { code: "RESEARCH_HANDOFF_FAILED", phase: "RESEARCH_HANDOFF" });
  assert.deepEqual(classifyInvestigationFailure(error, true, true), { code: "RESEARCH_HANDOFF_FAILED", phase: "RESEARCH_HANDOFF" });
  assert.deepEqual(classifyInvestigationFailure(new Error("provider failed"), false, true), { code: "INVESTIGATION_FAILED", phase: "INVESTIGATION" });
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
