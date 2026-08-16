import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evaluateEvidenceRecovery, writeEvidenceRecoveryReport } from "./evidence-recovery.ts";
import { FileSourceStore } from "./source-store.ts";

test("measures a source omitted from the memo but recovered through the complete local index", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-evidence-recovery-"));
  try {
    const sourceStore = await FileSourceStore.open(root);
    const source = await sourceStore.capture({ kind: "SOURCE_CONTENT", provider: "fixture", providerRoute: "fixture.web.fetch", sourceUrl: "https://example.test/large", mimeType: "text/plain", content: `${"prefix ".repeat(400_000)}late material recovery phrase`, provenance: {} });
    const report = await evaluateEvidenceRecovery({
      sourceStore,
      goldSources: [{ sourceRef: source.ref, recoveryQueries: ["late material recovery phrase"] }],
      memos: ["The concise memo omitted the source."],
      ledgerSourceRefs: [],
      utilizedSourceRefs: [source.ref],
    });
    assert.equal(report.capturedGoldSources, 1);
    assert.equal(report.recoverableCapturedGoldSources, 1);
    assert.equal(report.correctlyUtilizedRecoverableGoldSources, 1);
    assert.equal(report.sources[0]?.recoveryPath, "INDEX");
    await writeEvidenceRecoveryReport(root, report);
    assert.match(await readFile(join(root, ".work", "evidence-recovery.json"), "utf8"), /INDEX/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not call binary-only sources recoverable without a memo or ledger ref", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-evidence-recovery-binary-"));
  try {
    const sourceStore = await FileSourceStore.open(root);
    const source = await sourceStore.capture({ kind: "SOURCE_CONTENT", provider: "fixture", providerRoute: "fixture.web.fetch", sourceUrl: "https://example.test/file.pdf", mimeType: "application/pdf", content: new Uint8Array([37, 80, 68, 70]), provenance: {} });
    const report = await evaluateEvidenceRecovery({ sourceStore, goldSources: [{ sourceRef: source.ref, recoveryQueries: ["anything"] }] });
    assert.equal(report.capturedGoldSources, 1);
    assert.equal(report.recoverableCapturedGoldSources, 0);
    assert.equal(report.sources[0]?.recoveryPath, "NONE");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
