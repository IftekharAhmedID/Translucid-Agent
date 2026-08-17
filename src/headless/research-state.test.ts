import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileSourceStore } from "./source-store.ts";
import { ResearchStateStore, verifyResearchSnapshot, writeResearchSnapshot } from "./research-state.ts";

test("persists model-authored claim state and rejects unknown source references", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-research-state-"));
  try {
    const sourceStore = await FileSourceStore.open(root);
    await sourceStore.capture({ kind: "SOURCE_CONTENT", provider: "fixture", providerRoute: "fixture.record", sourceUrl: "https://example.test/record", mimeType: "application/json", content: { title: "Record", detail: "Detail" }, provenance: {} });
    const state = await ResearchStateStore.open(root, sourceStore);
    state.recordRoute("web.search");
    await assert.rejects(state.set({ claims: [{ id: "F001", claim: "Unknown", provisionalStatus: "unresolved", supportingRefs: ["S9"], conflictingRefs: [], remainingGap: "Find a record", importance: "material" }] }), /unknown source/i);
    await state.set({ identityAnchors: ["candidate@example.test"], claims: [{ id: "F001", claim: "Candidate appears in the record", provisionalStatus: "established", supportingRefs: ["S1"], conflictingRefs: [], remainingGap: null, importance: "material" }] });
    const current = await state.current();
    assert.equal(current?.claims[0]?.provisionalStatus, "established");
    assert.deepEqual(current?.sourceRefs, ["S1"]);
    assert.deepEqual(current?.attemptedRoutes, ["web.search"]);
    assert.match(await readFile(join(root, ".work", "research-state.json"), "utf8"), /candidate@example\.test/);
    await sourceStore.capture({ kind: "SEARCH_DISCOVERY", provider: "exa", providerRoute: "exa.search", sourceUrl: "https://api.exa.ai/search", mimeType: "application/json", content: { query: "new lead" }, provenance: {} });
    state.recordRoute("exa.search");
    await state.refresh();
    assert.deepEqual((await state.current())?.sourceRefs, ["S1", "S2"]);
    assert.deepEqual((await state.current())?.attemptedRoutes, ["exa.search", "web.search"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshots and verifies the direct research state and immutable source blobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-research-snapshot-"));
  try {
    await mkdir(join(root, "input"), { recursive: true });
    await writeFile(join(root, "input", "manifest.json"), JSON.stringify({ inputs: [] }));
    await writeFile(join(root, "input", "document.json"), "document");
    await writeFile(join(root, "input", "document.txt"), "document text");
    const sourceStore = await FileSourceStore.open(root);
    await sourceStore.capture({ kind: "SOURCE_CONTENT", provider: "fixture", providerRoute: "fixture.record", sourceUrl: "https://example.test/record", mimeType: "application/json", content: { title: "Record", detail: "Detail" }, provenance: {} });
    const state = await ResearchStateStore.open(root, sourceStore);
    await state.set({ claims: [{ id: "F001", claim: "Record exists", provisionalStatus: "established", supportingRefs: ["S1"], conflictingRefs: [], remainingGap: null, importance: "material" }] });
    await sourceStore.excerpts({ sourceRef: "S1", queries: ["Record"] });
    await writeResearchSnapshot(root, { runtime: "LOCAL", researchModel: "gpt-5.6-luna" }, sourceStore);
    assert.deepEqual(await verifyResearchSnapshot(root), { runtime: "LOCAL", researchModel: "gpt-5.6-luna", artifactCount: 6 });
    await sourceStore.excerpts({ sourceRef: "S1", queries: ["Detail"] });
    assert.deepEqual(await verifyResearchSnapshot(root), { runtime: "LOCAL", researchModel: "gpt-5.6-luna", artifactCount: 6 });
    await writeFile(join(root, "sources", "blobs", `${(await sourceStore.get("S1")).sha256}.json`), "tampered");
    await assert.rejects(verifyResearchSnapshot(root), /hash differs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
