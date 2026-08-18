import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ReportStore } from "./report-store.ts";
import { ResearchStateStore } from "./research-state.ts";
import { FileSourceStore } from "./source-store.ts";

test("materializes committed v3 findings deterministically without a semantic writer", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-report-v3-"));
  try {
    await mkdir(join(root, "input"), { recursive: true });
    await writeFile(join(root, "input", "document.json"), JSON.stringify({ pages: [{ page: 1, lines: [{ line: 1, text: "Synthetic Candidate" }] }] }));
    const sourceStore = await FileSourceStore.open(root);
    const source = await sourceStore.capture({ kind: "SOURCE_CONTENT", provider: "fixture", providerRoute: "fixture.record", sourceUrl: "https://example.test/record", title: "Record", mimeType: "text/plain", content: "Contribution record", provenance: {} });
    const researchState = await ResearchStateStore.open(root, sourceStore);
    await researchState.planSet({ identityAnchors: ["Synthetic Candidate"], targets: [
      { id: "contribution", section: "Career", predicate: "Made a material contribution", importance: "HIGH", anchor: { kind: "PDF_TEXT", page: 1, lineStart: 1, lineEnd: 1, exact: "Synthetic Candidate" } },
      { id: "discovered", section: "Additional", predicate: "A material discovered fact", importance: "MEDIUM", anchor: { kind: "DISCOVERED", basis: "A citable independent record made this material to the assessment." } },
    ] });
    await researchState.beginSynthesis();
    await researchState.upsertFinding({ targetId: "contribution", conclusion: "Contribution is established.", status: "ESTABLISHED", evidence: [{ sourceRef: source.ref, relation: "SUPPORTS", comment: "The record establishes contribution, not leadership." }], rationale: "Direct record.", remainingGap: null });
    await researchState.upsertFinding({ targetId: "discovered", conclusion: "The discovered fact is unresolved.", status: "UNRESOLVED", evidence: [], rationale: "No sufficient record.", remainingGap: "A primary record is still needed." });
    await researchState.setSummary({ text: "Contribution is established; the discovered fact remains unresolved.", targetIds: ["contribution"] });
    await researchState.commit();
    const store = await ReportStore.open(root, { runId: "run-v3", inputSha256: "a".repeat(64), startedAt: "2026-08-18T00:00:00.000Z", runtime: "LOCAL", model: "deepseek-v4-pro", sourceStore, researchState });
    await store.bindResearchSnapshot("b".repeat(64));
    await store.materializeV3();
    const result = await store.result("2026-08-18T01:00:00.000Z");
    assert.equal(result.schemaVersion, 4);
    assert.equal(result.findings[0]?.evidence, "The record establishes contribution, not leadership. [S1]");
    assert.equal(result.findings[1]?.anchor.kind, "DISCOVERED");
    assert.deepEqual(result.summaryResearchClaimIds, ["contribution"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
