import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readCompletedResearchMemos } from "./controller.ts";

test("reads completed specialist memos and reports children without a snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-memos-"));
  const memoDirectory = join(root, ".work", "memos");
  try {
    await mkdir(memoDirectory, { recursive: true });
    await writeFile(join(memoDirectory, "professional-researcher-child-1.md"), "# professional-researcher memo\n\nSession: child-1\n\nCompleted finding [S1].\n");

    const result = await readCompletedResearchMemos(memoDirectory, [
      { id: "child-1", agent: "professional-researcher" },
      { id: "child-2", agent: "github-researcher" },
    ]);

    assert.equal(result.memos.length, 1);
    assert.match(result.memos[0] ?? "", /Completed finding \[S1\]/);
    assert.deepEqual(result.completedSessionIds, new Set(["child-1"]));
    assert.match(result.warnings.join("\n"), /github-researcher.*child-2.*no completed memo/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails the research handoff when no specialist memo completed", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-empty-memos-"));
  try {
    await assert.rejects(
      readCompletedResearchMemos(join(root, ".work", "memos"), [{ id: "child-1", agent: "professional-researcher" }]),
      /no specialist memo completed/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
