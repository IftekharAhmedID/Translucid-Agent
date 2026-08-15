import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ReportStore, ReportStoreError, reportFindingInputSchema } from "./report-store.ts";
import { FileSourceStore } from "./source-store.ts";

const INPUT_SHA256 = "a".repeat(64);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "translucid-report-store-"));
  await mkdir(join(root, "input"), { recursive: true });
  await mkdir(join(root, "sources", "blobs"), { recursive: true });
  await writeFile(join(root, "input", "document.json"), JSON.stringify({
    schemaVersion: 1,
    pageCount: 2,
    pages: [
      { page: 1, lines: [
        { line: 1, text: "Career Experience" },
        { line: 2, text: "CE-SW Runtimes, Arm Ltd., Cambridge, UK 2023–present" },
        { line: 3, text: "Principal Software Engineer" },
      ], text: "", sparse: false, links: [] },
      { page: 2, lines: [{ line: 1, text: "Education" }], text: "", sparse: false, links: [] },
    ],
  }));
  await writeFile(join(root, "sources", "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    sources: [{
      ref: "S1",
      kind: "SOURCE_CONTENT",
      provider: "exa",
      providerRoute: "exa.contents",
      sourceUrl: "https://example.com/profile",
      title: "Profile",
      retrievedAt: "2026-08-14T00:00:00.000Z",
      sha256: "b".repeat(64),
      byteLength: 1,
      mimeType: "text/plain",
      relativePath: "sources/blobs/source.txt",
      sourceAuthority: "CONTEXT",
      independenceGroup: "domain:example.com",
      canonicalSourceUrl: "https://example.com/profile",
      provenance: {},
    }],
  }));
  await writeFile(join(root, "sources", "blobs", "source.txt"), "x");
  const sourceStore = await FileSourceStore.open(root);
  const options = {
    runId: "run-1",
    inputSha256: INPUT_SHA256,
    startedAt: "2026-08-14T00:00:00.000Z",
    runtime: "LOCAL" as const,
    model: "research-model",
    sourceStore,
  };
  return { root, options, store: await ReportStore.open(root, options) };
}

const finding = {
  findingId: "F001",
  section: "Career Experience",
  claim: "Arm role and employment interval",
  anchor: {
    kind: "PDF_TEXT" as const,
    page: 1,
    lineStart: 2,
    lineEnd: 3,
    exact: "CE-SW Runtimes, Arm Ltd., Cambridge, UK 2023–present\nPrincipal Software Engineer",
  },
  evidence: "The public profile is consistent with the role and interval.",
  notes: "",
  status: 2 as const,
  sourceRefs: ["S1"],
};

test("persists summary and idempotent finding upserts across restart", async () => {
  const { root, options, store } = await fixture();
  try {
    await store.setSummary({ summary: "The investigation corroborated the current role." });
    await store.upsertFinding(finding);
    await store.upsertFinding({ ...finding, evidence: "Updated evidence synthesis." });

    const progress = await store.progress();
    assert.equal(progress.revision, 3);
    assert.equal(progress.findings.length, 1);
    assert.equal(progress.findings[0]?.order, 1);
    assert.equal(progress.findings[0]?.evidence, "Updated evidence synthesis.");
    assert.deepEqual(progress.findings[0]?.sources, [{ sourceRef: "S1", title: "Profile", url: "https://example.com/profile" }]);

    const reopened = await ReportStore.open(root, options);
    assert.deepEqual(await reopened.progress(), progress);
    assert.equal(JSON.parse(await readFile(join(root, ".work", "report-draft.json"), "utf8")).findings.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serializes concurrent finding mutations without losing updates", async () => {
  const { root, store } = await fixture();
  try {
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.upsertFinding({
      ...finding,
      findingId: `F${String(index + 1).padStart(3, "0")}`,
      claim: `Claim ${index + 1}`,
    })));
    const progress = await store.progress();
    assert.equal(progress.findings.length, 20);
    assert.deepEqual(progress.findings.map(({ order }) => order), Array.from({ length: 20 }, (_, index) => index + 1));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns actionable errors for invalid anchors and source references", async () => {
  const { root, store } = await fixture();
  try {
    await assert.rejects(
      store.upsertFinding({ ...finding, anchor: { ...finding.anchor, exact: "Text that is not in the résumé" } }),
      (error: unknown) => error instanceof ReportStoreError && error.code === "INVALID_ANCHOR" && error.field === "anchor.exact",
    );
    await assert.rejects(
      store.upsertFinding({ ...finding, sourceRefs: ["S999"] }),
      (error: unknown) => error instanceof ReportStoreError && error.code === "UNKNOWN_SOURCE" && error.field === "sourceRefs",
    );
    assert.equal((await store.progress()).revision, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publishing requires basic structure and makes the report immutable", async () => {
  const { root, store } = await fixture();
  try {
    await assert.rejects(store.finalize(), (error: unknown) => error instanceof ReportStoreError && error.code === "INCOMPLETE_REPORT");
    await store.setSummary({ summary: "Summary" });
    await store.upsertFinding(finding);
    await store.finalize();
    await assert.rejects(store.removeFinding({ findingId: "F001" }), (error: unknown) => error instanceof ReportStoreError && error.code === "REPORT_IMMUTABLE");
    const result = await store.result("2026-08-14T01:00:00.000Z");
    assert.equal(result.schemaVersion, 2);
    assert.equal(result.run.inputSha256, INPUT_SHA256);
    assert.equal(result.findings[0]?.sources[0]?.url, "https://example.com/profile");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finding status accepts only the five documented values", () => {
  for (const status of [-2, -1, 0, 1, 2]) assert.equal(reportFindingInputSchema.parse({ ...finding, status }).status, status);
  assert.throws(() => reportFindingInputSchema.parse({ ...finding, status: 3 }));
  assert.throws(() => reportFindingInputSchema.parse({ ...finding, status: 0.5 }));
});
