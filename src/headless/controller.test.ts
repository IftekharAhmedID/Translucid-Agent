import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildFinalizerContext, readCompletedResearchMemos, resultForAudit, waitForResearchIdle } from "./controller.ts";
import type { InvestigationResult } from "./result-contract.ts";
import { FileSourceStore } from "./source-store.ts";

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

test("waits for an asynchronously prompted research session to become idle", async () => {
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

test("builds finalizer context from parsed JSON and memo-cited source metadata without stored bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-finalizer-context-"));
  try {
    await mkdir(join(root, "input"), { recursive: true });
    await writeFile(join(root, "input", "document.json"), JSON.stringify({ pages: [{ text: "Canonical resume" }] }));
    const store = await FileSourceStore.open(root);
    await store.capture({
      kind: "SOURCE_CONTENT",
      provider: "github",
      providerRoute: "github.rest",
      sourceUrl: "https://api.github.com/repos/example/one",
      mimeType: "application/json",
      content: { privateMarker: "SOURCE_BODY_MUST_NOT_ENTER_PROMPT" },
      provenance: {},
    });
    await store.capture({
      kind: "SOURCE_CONTENT",
      provider: "exa",
      providerRoute: "exa.contents",
      sourceUrl: "https://example.com/unused",
      mimeType: "text/plain",
      content: "UNUSED_SOURCE_BODY",
      provenance: {},
    });

    const context = await buildFinalizerContext(root, store, "Completed finding [S1].");
    assert.deepEqual(context.input, { pages: [{ text: "Canonical resume" }] });
    assert.deepEqual(context.citedSources.map(({ ref }) => ref), ["S1"]);
    assert.doesNotMatch(JSON.stringify(context), /SOURCE_BODY_MUST_NOT_ENTER_PROMPT|UNUSED_SOURCE_BODY|exactStoredBody|documentText/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes unknown memo source refs with an explicit warning instead of discarding completed research", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-unknown-memo-ref-"));
  try {
    await mkdir(join(root, "input"), { recursive: true });
    await writeFile(join(root, "input", "document.json"), JSON.stringify({ pages: [] }));
    const store = await FileSourceStore.open(root);
    await store.capture({
      kind: "SOURCE_CONTENT",
      provider: "github",
      providerRoute: "github.rest",
      sourceUrl: "https://api.github.com/example",
      mimeType: "application/json",
      content: { value: "known" },
      provenance: {},
    });

    const context = await buildFinalizerContext(root, store, "Known [S1]. Unsupported [S2].");
    assert.deepEqual(context.citedSources.map(({ ref }) => ref), ["S1"]);
    assert.doesNotMatch(context.researchMemos, /\bS2\b/);
    assert.match(context.researchMemos, /unknown source reference was removed/i);
    assert.deepEqual(context.warnings, ["Research memo cited unknown source S2; that citation was removed and its scope remains unresolved."]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auditor view removes provisional audit data and unused source metadata", () => {
  const result = {
    sources: [{ ref: "S1" }, { ref: "S2" }],
    audit: { status: "PASSED", warnings: ["provisional"] },
  } as unknown as InvestigationResult;

  const view = resultForAudit(result, new Set(["S1"]));
  assert.equal("audit" in view, false);
  assert.deepEqual(view.sources.map(({ ref }) => ref), ["S1"]);
});

test("controller never reconstructs handoffs from messages or injects duplicate or full source text", async () => {
  const source = await readFile(new URL("./controller.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /session\.messages|document\.txt|exactStoredBody|sourceBundle/);
});
