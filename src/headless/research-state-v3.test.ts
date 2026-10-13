import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileSourceStore } from "./source-store.ts";
import { ResearchStateStore, knownResearchPredicateIds } from "./research-state.ts";

const anchor = { kind: "PDF_TEXT" as const, page: 1, lineStart: 1, lineEnd: 1, exact: "Synthetic Candidate" };

test("parallel findings and summary retain every acknowledged write before commit", async () => {
  const { root, sourceStore, source } = await fixture();
  try {
    const state = await ResearchStateStore.open(root, sourceStore);
    const ids = ["first", "second", "third"];
    await state.planSet({ targets: ids.map(id => ({ id, section: "Career", predicate: id, importance: "HIGH", anchor })) });
    await state.beginSynthesis();
    const writes = Promise.all([
      ...ids.map(targetId => state.upsertFinding({ targetId, conclusion: "The source supports this claim.", status: "ESTABLISHED", evidence: [{ sourceRef: source.ref, relation: "SUPPORTS", comment: "Direct record of the claim." }], rationale: "Direct record.", remainingGap: null })),
      state.setSummary({ text: "All three claims have direct records.", targetIds: ids }),
    ]);
    const [results, prevalidated, committed] = await Promise.all([writes, state.validateCommit(), state.commit()]);
    results.push(committed);
    assert.equal(prevalidated.findings.length, ids.length);
    assert.equal(new Set(results.map(r => r.revision)).size, results.length);
    const current = await state.current();
    assert.equal(current?.phase, "COMMITTED");
    assert.deepEqual(current?.findings?.map(f => f.targetId).sort(), ids.sort());
    assert.deepEqual((await (await ResearchStateStore.open(root, sourceStore)).current())?.findings, current?.findings);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent plans cannot replace one another and rejected mutations do not poison later work", async () => {
  const { root, sourceStore } = await fixture();
  try {
    const state = await ResearchStateStore.open(root, sourceStore);
    const target = { id: "initial", section: "Career", predicate: "Initial claim", importance: "HIGH", anchor };
    const plans = await Promise.allSettled([state.planSet({ targets: [target] }), state.planSet({ targets: [{ ...target, id: "replacement" }] })]);
    assert.equal(plans.filter(r => r.status === "fulfilled").length, 1);
    await Promise.all([state.targetAdd({ target: { ...target, id: "second" } }), state.targetAdd({ target: { ...target, id: "third" } })]);
    assert.deepEqual((await state.current())?.targets?.map(t => t.id), ["initial", "second", "third"]);
    await state.beginSynthesis();
    const finding = { conclusion: "Not established.", status: "UNRESOLVED", evidence: [], rationale: "No direct evidence.", remainingGap: "Need a primary record." };
    const writes = await Promise.allSettled([state.upsertFinding({ ...finding, targetId: "unknown" }), state.upsertFinding({ ...finding, targetId: "initial" }), state.upsertFinding({ ...finding, targetId: "second" })]);
    assert.equal(writes[0]?.status, "rejected");
    assert.deepEqual((await state.current())?.findings?.map(f => f.targetId), ["initial", "second"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "translucid-research-v3-"));
  await mkdir(join(root, "input"), { recursive: true });
  await writeFile(join(root, "input", "document.json"), JSON.stringify({ pages: [{ page: 1, lines: [{ line: 1, text: "Synthetic Candidate" }] }] }));
  const sourceStore = await FileSourceStore.open(root);
  const source = await sourceStore.capture({ kind: "SOURCE_CONTENT", provider: "fixture", providerRoute: "fixture.record", sourceUrl: "https://example.test/record", mimeType: "text/plain", content: "Record supports the contribution.", provenance: {} });
  return { root, sourceStore, source };
}

test("placeholder predicates cannot become scored investigation targets", async () => {
  const { root, sourceStore } = await fixture();
  try {
    const state = await ResearchStateStore.open(root, sourceStore);
    const target = { id: "PROBE", section: "Probe", predicate: "probe", importance: "MEDIUM", anchor };
    await assert.rejects(() => state.planSet({ targets: [target] }), /material claim/i);
    assert.equal(await state.current(), undefined);
    await state.planSet({ targets: [{ ...target, id: "IDENT", section: "Identity", predicate: "The submitted person is Synthetic Candidate." }] });
    for (const predicate of ["probe", "Placeholder", "TODO", "TBD"]) {
      await assert.rejects(() => state.targetAdd({ target: { ...target, predicate } }), /material claim/i);
    }
    assert.deepEqual((await state.current())?.targets?.map(t => t.id), ["IDENT"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v3 persists targets, findings, comments, summary coverage, and host inventory", async () => {
  const { root, sourceStore, source } = await fixture();
  try {
    const state = await ResearchStateStore.open(root, sourceStore);
    await state.planSet({ identityAnchors: ["Synthetic Candidate"], targets: [{ id: "contribution", section: "Career", predicate: "Made a material contribution", importance: "HIGH", anchor }, { id: "discovered-fact", section: "Additional", predicate: "A material discovered fact", importance: "MEDIUM", anchor: { kind: "DISCOVERED", basis: "Found during investigation and material to the professional assessment." } }] });
    await state.beginSynthesis();
    await state.upsertFinding({ targetId: "contribution", conclusion: "The contribution is established.", status: "ESTABLISHED", evidence: [{ sourceRef: source.ref, relation: "SUPPORTS", comment: "The record establishes contribution, not leadership." }], rationale: "The source directly records the work.", remainingGap: null });
    await state.upsertFinding({ targetId: "discovered-fact", conclusion: "The discovered fact is unresolved.", status: "UNRESOLVED", evidence: [], rationale: "No citable primary record was found.", remainingGap: "A primary record is still needed." });
    await state.setSummary({ text: "The material contribution is established; the discovered fact remains unresolved.", targetIds: ["contribution"] });
    state.recordRoute("web.fetch");
    await state.sealHostInventory();
    const current = await state.current();
    assert.equal(current?.schemaVersion, 3);
    assert.equal(current?.phase, "SYNTHESIZING");
    assert.deepEqual(current?.sourceRefs, [source.ref]);
    assert.deepEqual(current?.attemptedRoutes, ["web.fetch"]);
    assert.deepEqual(knownResearchPredicateIds(current!), ["contribution", "discovered-fact"]);
    await state.commit();
    const committed = await state.current();
    assert.equal(committed?.phase, "COMMITTED");
    assert.ok(committed?.committedAt);
    assert.equal(committed?.summary?.targetIds[0], "contribution");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v3 rejects missing target dispositions, invalid status evidence, and incomplete HIGH summary coverage", async () => {
  const { root, sourceStore, source } = await fixture();
  try {
    const state = await ResearchStateStore.open(root, sourceStore);
    await state.planSet({ identityAnchors: ["Synthetic Candidate"], targets: [{ id: "high", section: "Career", predicate: "High target", importance: "HIGH", anchor }, { id: "medium", section: "Career", predicate: "Medium target", importance: "MEDIUM", anchor }] });
    await state.beginSynthesis();
    await assert.rejects(state.upsertFinding({ targetId: "high", conclusion: "Bad", status: "ESTABLISHED", evidence: [], rationale: "No evidence", remainingGap: null }), /SUPPORTS evidence/i);
    await state.upsertFinding({ targetId: "high", conclusion: "Good", status: "ESTABLISHED", evidence: [{ sourceRef: source.ref, relation: "SUPPORTS", comment: "The record establishes the target." }], rationale: "Direct record.", remainingGap: null });
    await state.setSummary({ text: "Summary", targetIds: [] });
    await assert.rejects(state.commit(), /missing.*target|disposition|summary/i);
    await state.upsertFinding({ targetId: "medium", conclusion: "Unknown", status: "UNRESOLVED", evidence: [], rationale: "Insufficient evidence.", remainingGap: "Need a record." });
    await assert.rejects(state.commit(), /HIGH.*summary|summary.*target/i);
    await state.setSummary({ text: "Summary", targetIds: ["high"] });
    await state.commit();
    assert.equal((await state.current())?.phase, "COMMITTED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v3 enforces compact finding and summary ceilings with actionable word counts", async () => {
  const { root, sourceStore, source } = await fixture();
  try {
    const state = await ResearchStateStore.open(root, sourceStore);
    await state.planSet({ identityAnchors: ["Synthetic Candidate"], targets: [{ id: "target", section: "Career", predicate: "Target", importance: "HIGH", anchor }] });
    await state.beginSynthesis();
    const words = (count: number) => Array.from({ length: count }, (_, index) => `word${index}`).join(" ");
    await assert.rejects(
      state.upsertFinding({ targetId: "target", conclusion: words(91), status: "ESTABLISHED", evidence: [{ sourceRef: source.ref, relation: "SUPPORTS", comment: "The record establishes the target." }], rationale: "Direct record.", remainingGap: null }),
      /conclusion.*91.*90/i,
    );
    await state.upsertFinding({ targetId: "target", conclusion: "The target is established.", status: "ESTABLISHED", evidence: [{ sourceRef: source.ref, relation: "SUPPORTS", comment: "The record establishes the target." }], rationale: "Direct record.", remainingGap: null });
    await assert.rejects(state.setSummary({ text: words(221), targetIds: ["target"] }), /text.*221.*220/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v3 does not silently upgrade an existing v2 ledger", async () => {
  const { root, sourceStore } = await fixture();
  try {
    const state = await ResearchStateStore.open(root, sourceStore);
    await state.set({ publicationReady: true, claims: [{ id: "C1", claim: "Legacy", provisionalStatus: "unresolved", supportingRefs: [], conflictingRefs: [], remainingGap: "Need evidence.", importance: "material" }] });
    await assert.rejects(state.planSet({ identityAnchors: [], targets: [] }), /v2|upgrade|legacy/i);
    assert.equal((await state.current())?.schemaVersion, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
