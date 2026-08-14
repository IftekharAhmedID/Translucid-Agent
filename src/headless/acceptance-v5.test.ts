import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evaluateV5Acceptance, v5GoldManifestSchema } from "./acceptance-v5.ts";
import { FileSourceStore } from "./source-store.ts";

async function acceptanceRun(): Promise<{ root: string; gold: unknown }> {
  const root = await mkdtemp(join(tmpdir(), "translucid-v5-acceptance-"));
  const store = await FileSourceStore.open(root);
  const source = await store.capture({
    kind: "SOURCE_CONTENT",
    provider: "public-fetch",
    providerRoute: "web.fetch",
    sourceUrl: "https://records.organization.test/profile",
    mimeType: "application/json",
    content: { role: "Casey Morgan served as Principal Engineer at Example Corp." },
    provenance: {},
  });
  await mkdir(join(root, "input"), { recursive: true });
  await writeFile(join(root, "result.json"), JSON.stringify({
    schemaVersion: "1.1",
    run: { id: "gold-run" },
    claims: [{ id: "C1", sourceSpan: { page: 1, text: "Principal Engineer at Example Corp" }, facets: [{ key: "title", status: "SUPPORTED", evidenceIds: ["E1"] }] }],
    evidence: [{ id: "E1", claimId: "C1", facetKeys: ["title"], relation: "SUPPORTS", sourceRef: source.ref, exactQuote: "Casey Morgan served as Principal Engineer at Example Corp.", sourceLocation: { path: "role" } }],
    sources: [{ ref: source.ref, sha256: source.sha256, relativePath: source.relativePath, mimeType: source.mimeType }],
  }));
  const gold = {
    schemaVersion: 1,
    assertions: [{
      assertionId: "title",
      sourceSpan: { page: 1, text: "Principal Engineer at Example Corp" },
      facetKey: "title",
      expectedDisposition: "SUPPORTED",
      acceptableEvidence: [{ sourceSha256: source.sha256, exactQuote: "Casey Morgan served as Principal Engineer at Example Corp.", relation: "SUPPORTS" }],
      forbiddenMappings: [],
    }],
  };
  return { root, gold };
}

test("acceptance evaluator reports complete gold recall without mutating the run", async () => {
  const { root, gold } = await acceptanceRun();
  try {
    const ledgerPath = join(root, ".work", "finalization", "v5", "excerpts.json");
    await mkdir(join(root, ".work", "finalization", "v5"), { recursive: true });
    const ledger = `${JSON.stringify({ schemaVersion: 1, excerpts: [{ ref: `X${"a".repeat(64)}`, sourceRef: "S1", path: "$", offsetStart: 0, offsetEnd: 0, text: "" }] }, null, 2)}\n`;
    await writeFile(ledgerPath, ledger);
    const metrics = await evaluateV5Acceptance(root, gold);
    assert.equal(metrics.passed, true, JSON.stringify(metrics));
    assert.equal(metrics.dispositionCoverage.rate, 1);
    assert.equal(metrics.goldEvidenceRecall.rate, 1);
    assert.equal(await readFile(ledgerPath, "utf8"), ledger);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("acceptance evaluator fails a supported facet that is artificially unresolved", async () => {
  const { root, gold } = await acceptanceRun();
  try {
    const resultPath = join(root, "result.json");
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    result.claims[0].facets[0].status = "UNRESOLVED";
    result.claims[0].facets[0].evidenceIds = [];
    result.evidence = [];
    await writeFile(resultPath, JSON.stringify(result));

    const metrics = await evaluateV5Acceptance(root, gold);
    assert.equal(metrics.passed, false);
    assert.deepEqual(metrics.artificialUnresolved, ["title"]);
    assert.deepEqual(metrics.missingGoldEvidence, ["title"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("acceptance evaluator rejects result source metadata that differs from the immutable manifest", async () => {
  const { root, gold } = await acceptanceRun();
  try {
    const resultPath = join(root, "result.json");
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    result.sources[0].relativePath = "sources/blobs/not-the-captured-source.json";
    await writeFile(resultPath, JSON.stringify(result));

    const metrics = await evaluateV5Acceptance(root, gold);
    assert.equal(metrics.passed, false);
    assert.deepEqual(metrics.invalidSourceRefs, ["S1"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gold manifests require acceptable evidence for resolved assertions", () => {
  assert.throws(() => v5GoldManifestSchema.parse({ schemaVersion: 1, assertions: [{ assertionId: "x", sourceSpan: { text: "x" }, facetKey: "x", expectedDisposition: "SUPPORTED", acceptableEvidence: [], forbiddenMappings: [] }] }), /acceptable evidence/i);
});
