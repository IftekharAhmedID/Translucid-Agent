import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileSourceStore } from "./source-store.ts";

test("captures immutable sources and deduplicates identical content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-source-store-"));
  try {
    const store = await FileSourceStore.open(directory);
    const first = await store.capture({
      kind: "SOURCE_CONTENT",
      provider: "fixture",
      providerRoute: "fixture.web.fetch",
      sourceUrl: "https://example.test/profile",
      mimeType: "application/json",
      content: { name: "Synthetic Candidate", title: "Principal Engineer" },
      provenance: { requestFingerprint: "request-a" },
    });
    const duplicate = await store.capture({
      kind: "SOURCE_CONTENT",
      provider: "fixture",
      providerRoute: "fixture.web.fetch",
      sourceUrl: "https://example.test/profile",
      mimeType: "application/json",
      content: { name: "Synthetic Candidate", title: "Principal Engineer" },
      provenance: { requestFingerprint: "request-a" },
    });

    assert.equal(first.ref, "S1");
    assert.equal(duplicate.ref, "S1");
    assert.equal((await store.list()).length, 1);
    assert.equal((await store.verify()).valid, true);
    assert.deepEqual(JSON.parse(await readFile(join(directory, first.relativePath), "utf8")), {
      name: "Synthetic Candidate",
      title: "Principal Engineer",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("assigns unique source references under concurrent capture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-source-concurrency-"));
  try {
    const store = await FileSourceStore.open(directory);
    const captured = await Promise.all(Array.from({ length: 20 }, (_, index) => store.capture({
      kind: "SOURCE_CONTENT",
      provider: "fixture",
      providerRoute: "fixture.web.fetch",
      sourceUrl: `https://example.test/${index}`,
      mimeType: "text/plain",
      content: `source-${index}`,
      provenance: { index },
    })));

    assert.equal(new Set(captured.map(({ ref }) => ref)).size, 20);
    assert.equal((await store.list()).length, 20);
    assert.equal((await store.verify()).valid, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("returns exact JSON paths and bounded text windows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-source-excerpts-"));
  try {
    const store = await FileSourceStore.open(directory);
    const json = await store.capture({
      kind: "SOURCE_CONTENT",
      provider: "fixture",
      providerRoute: "fixture.professional.profile",
      sourceUrl: "https://example.test/profile",
      mimeType: "application/json",
      content: { experience: [{ company: "Acme", title: "Principal Engineer" }] },
      provenance: {},
    });
    const text = await store.capture({
      kind: "SOURCE_CONTENT",
      provider: "fixture",
      providerRoute: "fixture.web.fetch",
      sourceUrl: "https://example.test/talk",
      mimeType: "text/plain",
      content: "Opening material. Casey Morgan presented the toolchain talk in Example City. Closing material.",
      provenance: {},
    });

    const jsonExcerpts = await store.excerpts({ sourceRef: json.ref, queries: ["Principal Engineer"] });
    const textExcerpts = await store.excerpts({ sourceRef: text.ref, queries: ["toolchain"], maxCharacters: 50 });

    assert.deepEqual(jsonExcerpts.excerpts[0], {
      ref: jsonExcerpts.excerpts[0]!.ref,
      path: "experience[0].title",
      offsetStart: jsonExcerpts.excerpts[0]!.offsetStart,
      offsetEnd: jsonExcerpts.excerpts[0]!.offsetEnd,
      text: "Principal Engineer",
    });
    assert.match(jsonExcerpts.excerpts[0]!.ref, /^X[a-f0-9]{64}$/);
    assert.match(await readFile(join(directory, ".work", "finalization", "v5", "excerpts.json"), "utf8"), /schemaVersion/);
    assert.match(textExcerpts.excerpts[0]!.text, /toolchain/);
    assert.ok(textExcerpts.excerpts[0]!.text.length <= 50);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("detects a source blob modified after capture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-source-integrity-"));
  try {
    const store = await FileSourceStore.open(directory);
    const captured = await store.capture({
      kind: "SOURCE_CONTENT",
      provider: "fixture",
      providerRoute: "fixture.web.fetch",
      sourceUrl: "https://example.test/source",
      mimeType: "text/plain",
      content: "original",
      provenance: {},
    });
    await import("node:fs/promises").then(({ writeFile }) => writeFile(join(directory, captured.relativePath), "modified"));

    const integrity = await store.verify();
    assert.equal(integrity.valid, false);
    assert.deepEqual(integrity.invalidSourceRefs, [captured.ref]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not persist empty JSON leaves as excerpt records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-source-empty-excerpts-"));
  try {
    const store = await FileSourceStore.open(directory);
    const source = await store.capture({
      kind: "SOURCE_CONTENT",
      provider: "fixture",
      providerRoute: "fixture.web.fetch",
      sourceUrl: "https://example.test/empty",
      mimeType: "application/json",
      content: { empty: "", readable: "Cambridge" },
      provenance: {},
    });
    const result = await store.excerpts({ sourceRef: source.ref, queries: ["empty", "Cambridge"] });
    assert.equal(result.excerpts.some(({ text }) => text.length === 0), false);
    const ledger = JSON.parse(await readFile(join(directory, ".work", "finalization", "v5", "excerpts.json"), "utf8")) as { excerpts: Array<{ text: string }> };
    assert.equal(ledger.excerpts.some(({ text }) => text.length === 0), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("finds deterministic bounded candidates from memo citations without network access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-source-candidates-"));
  try {
    const store = await FileSourceStore.open(directory, { finalizationVersion: "v5" });
    const official = await store.capture({
      kind: "SOURCE_CONTENT",
      provider: "public-fetch",
      providerRoute: "web.fetch",
      sourceUrl: "https://records.organization.test/maintainers/",
      title: "Project Atlas maintainers",
      mimeType: "text/plain",
      content: "Casey Morgan was promoted to the Project Atlas maintainer team.",
      provenance: {},
    });
    const context = await store.capture({
      kind: "SOURCE_CONTENT",
      provider: "public-fetch",
      providerRoute: "web.fetch",
      sourceUrl: "https://blog.publisher.test/project-atlas",
      title: "Project Atlas community",
      mimeType: "text/plain",
      content: "Casey Morgan contributed a pull request.",
      provenance: {},
    });
    const candidates = await store.findStoredExcerpts({
      statement: "Casey Morgan is a Project Atlas maintainer.",
      facets: [{ key: "status", statement: "Casey Morgan is a Project Atlas maintainer." }],
      researchMemos: `Casey Morgan Project Atlas maintainer promotion record [${official.ref}]`,
      eligibleSourceRefs: new Set([official.ref, context.ref]),
    });
    assert.equal(candidates.candidatesByFacet.status?.[0]?.sourceRef, official.ref);
    assert.match(candidates.candidatesByFacet.status?.[0]?.text ?? "", /Project Atlas maintainer team/);
    assert.ok((candidates.candidatesByFacet.status ?? []).length <= 8);
    assert.equal(new Set((candidates.candidatesByFacet.status ?? []).map(({ ref }) => ref)).size, (candidates.candidatesByFacet.status ?? []).length);
    assert.ok(Object.values(candidates.candidatesByFacet).flat().length <= 16);
    assert.ok(candidates.totalCharacters <= 16_000);
    assert.deepEqual(await store.findStoredExcerpts({
      statement: "Casey Morgan is a Project Atlas maintainer.",
      facets: [{ key: "status", statement: "Casey Morgan is a Project Atlas maintainer." }],
      researchMemos: `Casey Morgan Project Atlas maintainer promotion record [${official.ref}]`,
      eligibleSourceRefs: new Set([official.ref, context.ref]),
    }), candidates);
    assert.match(await readFile(join(directory, ".work", "finalization", "v5", "excerpts.json"), "utf8"), /schemaVersion/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("memo-tier candidates are globally ranked by excerpt overlap before source order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-source-ranking-"));
  try {
    const store = await FileSourceStore.open(directory, { finalizationVersion: "v5" });
    const first = await store.capture({ kind: "SOURCE_CONTENT", provider: "public-fetch", providerRoute: "web.fetch", sourceUrl: "https://records.organization.test/first", mimeType: "application/json", content: { a: "Casey contributed.", b: "Morgan contributed." }, provenance: {} });
    const second = await store.capture({ kind: "SOURCE_CONTENT", provider: "public-fetch", providerRoute: "web.fetch", sourceUrl: "https://records.organization.test/second", mimeType: "application/json", content: { a: "Casey used Project Atlas.", b: "Morgan used Project Atlas." }, provenance: {} });
    const strongest = await store.capture({ kind: "SOURCE_CONTENT", provider: "public-fetch", providerRoute: "web.fetch", sourceUrl: "https://records.organization.test/strongest", mimeType: "text/plain", content: "Casey Morgan is listed as a Project Atlas maintainer.", provenance: {} });
    const candidates = await store.findStoredExcerpts({
      statement: "Casey Morgan is a Project Atlas maintainer.",
      facets: [{ key: "status", statement: "Casey Morgan is a Project Atlas maintainer." }],
      researchMemos: `Casey Morgan Project Atlas maintainer records [${first.ref}] [${second.ref}] [${strongest.ref}]`,
      eligibleSourceRefs: new Set([first.ref, second.ref, strongest.ref]),
    });
    assert.equal(candidates.candidatesByFacet.status?.[0]?.sourceRef, strongest.ref);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundle retrieval searches the whole immutable corpus without promoting context authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-bundle-candidates-"));
  try {
    const store = await FileSourceStore.open(directory, { finalizationVersion: "v5" });
    const irrelevant = await store.capture({
      kind: "SOURCE_CONTENT",
      provider: "public-fetch",
      providerRoute: "web.fetch",
      sourceUrl: "https://records.organization.test/unrelated",
      title: "Unrelated directory",
      mimeType: "text/plain",
      content: "A different person joined a different organization.",
      provenance: {},
    });
    const context = await store.capture({
      kind: "SOURCE_CONTENT",
      provider: "public-fetch",
      providerRoute: "web.fetch",
      sourceUrl: "https://community.publisher.test/atlas",
      title: "Project Atlas maintainers",
      mimeType: "text/plain",
      content: "Casey Morgan is listed as a Project Atlas maintainer.",
      provenance: {},
    });
    const authorityBySourceRef = new Map([
      [irrelevant.ref, { sourceHash: irrelevant.sha256, effectiveAuthority: "FIRST_PARTY_INSTITUTIONAL" as const }],
      [context.ref, { sourceHash: context.sha256, effectiveAuthority: "CONTEXT" as const }],
    ]);

    const candidates = await store.findBundleExcerpts({
      bundleId: "B001",
      claims: [{
        claimKey: "C001",
        statement: "Casey Morgan maintains Project Atlas.",
        facets: [{ key: "status", kind: "AFFILIATION", statement: "Casey Morgan is a Project Atlas maintainer.", sourceFragment: "Project Atlas maintainer" }],
      }],
      researchMemos: `Incorrect memo pointer [${irrelevant.ref}]`,
      authorityBySourceRef,
    });

    const status = candidates.facets[0]!;
    assert.equal(status.claimKey, "C001");
    assert.equal(status.facetKey, "status");
    assert.equal(status.candidates[0]?.sourceRef, context.ref);
    assert.equal(status.candidates[0]?.effectiveAuthority, "CONTEXT");
    assert.equal(status.candidates[0]?.evidenceEligible, false);
    assert.equal(status.candidates[0]?.sourceHash, context.sha256);
    assert.equal(status.candidates[0]?.sourceUrl, "https://community.publisher.test/atlas");
    assert.ok(status.candidates.length <= 6);
    assert.ok(candidates.totalCharacters <= 30_000);
    assert.ok(candidates.uniqueExcerpts <= 30);
    assert.deepEqual(await store.findBundleExcerpts({
      bundleId: "B001",
      claims: [{
        claimKey: "C001",
        statement: "Casey Morgan maintains Project Atlas.",
        facets: [{ key: "status", kind: "AFFILIATION", statement: "Casey Morgan is a Project Atlas maintainer.", sourceFragment: "Project Atlas maintainer" }],
      }],
      researchMemos: `Incorrect memo pointer [${irrelevant.ref}]`,
      authorityBySourceRef,
    }), candidates);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundle retrieval fails closed when the frozen authority snapshot omits or mismatches a source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-bundle-authority-"));
  try {
    const store = await FileSourceStore.open(directory, { finalizationVersion: "v5" });
    const source = await store.capture({ kind: "SOURCE_CONTENT", provider: "public-fetch", providerRoute: "web.fetch", sourceUrl: "https://records.organization.test/atlas", mimeType: "text/plain", content: "Casey Morgan maintains Project Atlas.", provenance: {} });
    const request = {
      bundleId: "B001",
      claims: [{ claimKey: "C001", statement: "Casey Morgan maintains Project Atlas.", facets: [{ key: "status", kind: "AFFILIATION", statement: "Casey Morgan maintains Project Atlas.", sourceFragment: "Project Atlas" }] }],
      researchMemos: "",
    } as const;

    await assert.rejects(store.findBundleExcerpts({ ...request, authorityBySourceRef: new Map() }), /missing.*frozen authority/i);
    await assert.rejects(store.findBundleExcerpts({ ...request, authorityBySourceRef: new Map([[source.ref, { sourceHash: "f".repeat(64), effectiveAuthority: "DIRECT_WORK" as const }]]) }), /hash.*frozen authority/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
