import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileSourceStore } from "./source-store.ts";

test("captures immutable sources, deduplicates identical content, and verifies blobs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-source-store-"));
  try {
    const store = await FileSourceStore.open(directory);
    const first = await store.capture({ kind: "SOURCE_CONTENT", provider: "fixture", providerRoute: "fixture.web.fetch", sourceUrl: "https://example.test/profile", mimeType: "application/json", content: { name: "Synthetic Candidate" }, provenance: { requestFingerprint: "request-a" } });
    const duplicate = await store.capture({ kind: "SOURCE_CONTENT", provider: "fixture", providerRoute: "fixture.web.fetch", sourceUrl: "https://example.test/profile", mimeType: "application/json", content: { name: "Synthetic Candidate" }, provenance: { requestFingerprint: "request-a" } });
    assert.equal(first.ref, "S1");
    assert.equal(duplicate.ref, "S1");
    assert.equal((await store.list()).length, 1);
    assert.equal((await store.verify()).valid, true);
    assert.deepEqual(JSON.parse(await readFile(join(directory, first.relativePath), "utf8")), { name: "Synthetic Candidate" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("serializes concurrent captures into unique source references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-source-concurrency-"));
  try {
    const store = await FileSourceStore.open(directory);
    const captured = await Promise.all(Array.from({ length: 20 }, (_, index) => store.capture({ kind: "SOURCE_CONTENT", provider: "fixture", providerRoute: "fixture.web.fetch", sourceUrl: `https://example.test/${index}`, mimeType: "text/plain", content: `source-${index}`, provenance: { index } })));
    assert.equal(new Set(captured.map(({ ref }) => ref)).size, 20);
    assert.equal((await store.list()).length, 20);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("returns bounded JSON and text excerpts from captured local material", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-source-excerpts-"));
  try {
    const store = await FileSourceStore.open(directory);
    const json = await store.capture({ kind: "SOURCE_CONTENT", provider: "fixture", providerRoute: "fixture.profile", sourceUrl: "https://example.test/profile", mimeType: "application/json", content: { experience: [{ title: "Principal Engineer" }] }, provenance: {} });
    const text = await store.capture({ kind: "SOURCE_CONTENT", provider: "fixture", providerRoute: "fixture.web.fetch", sourceUrl: "https://example.test/talk", mimeType: "text/plain", content: "Opening material. Casey Morgan presented the toolchain talk in Example City. Closing material.", provenance: {} });
    const jsonExcerpts = await store.excerpts({ sourceRef: json.ref, queries: ["Principal Engineer"] });
    const textExcerpts = await store.excerpts({ sourceRef: text.ref, queries: ["toolchain"], maxCharacters: 50 });
    assert.equal(jsonExcerpts.excerpts[0]?.path, "experience[0].title");
    assert.match(jsonExcerpts.excerpts[0]?.ref ?? "", /^X[a-f0-9]{64}$/);
    assert.match(textExcerpts.excerpts[0]?.text ?? "", /toolchain/);
    assert.ok((textExcerpts.excerpts[0]?.text.length ?? 0) <= 50);
    assert.match(await readFile(join(directory, ".work", "source-excerpts.json"), "utf8"), /schemaVersion/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("centers a JSON excerpt on a late exact match instead of returning the leaf prefix", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-source-late-json-"));
  try {
    const store = await FileSourceStore.open(directory);
    await store.capture({ kind: "SOURCE_CONTENT", provider: "fixture", providerRoute: "fixture.record", sourceUrl: "https://example.test/late", mimeType: "application/json", content: { biography: `${"prefix ".repeat(900)}Principal Software Engineer at Arm` }, provenance: {} });
    const result = await store.excerpts({ sourceRef: "S1", queries: ["Principal Software Engineer at Arm"] });
    assert.equal(result.excerpts.length, 1);
    assert.match(result.excerpts[0]!.text, /Principal Software Engineer at Arm/);
    assert.ok(result.excerpts[0]!.offsetStart > 5_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prefers an exact phrase and reuses sibling JSON leaves for lexical recall", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-source-ranking-"));
  try {
    const store = await FileSourceStore.open(directory);
    await store.capture({ kind: "SOURCE_CONTENT", provider: "fixture", providerRoute: "fixture.record", sourceUrl: "https://example.test/ranking", mimeType: "application/json", content: {
      exact: "Principal Software Engineer at Arm",
      near: "Principal engineer worked with Arm",
    }, provenance: {} });
    await store.capture({ kind: "SOURCE_CONTENT", provider: "fixture", providerRoute: "fixture.record", sourceUrl: "https://example.test/siblings", mimeType: "application/json", content: { role: { title: "Principal Software Engineer", company: "Arm" } }, provenance: {} });
    const exact = await store.excerpts({ sourceRef: "S1", queries: ["Principal Software Engineer at Arm"] });
    assert.equal(exact.excerpts[0]?.path, "exact");
    const sibling = await store.excerpts({ sourceRef: "S2", queries: ["Principal Software Engineer from Arm"] });
    assert.deepEqual(new Set(sibling.excerpts.map(({ path }) => path)), new Set(["role.title", "role.company"]));
    const generic = await store.excerpts({ sourceRef: "S2", queries: ["generic engineer"] });
    assert.deepEqual(generic.excerpts, []);
    const reopened = await FileSourceStore.open(directory);
    assert.deepEqual(await reopened.excerpts({ sourceRef: "S2", queries: ["Principal Software Engineer from Arm"] }), sibling);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps persisted excerpts within the durable ledger bound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-source-long-excerpt-"));
  try {
    const store = await FileSourceStore.open(directory);
    await store.capture({ kind: "SOURCE_CONTENT", provider: "fixture", providerRoute: "fixture.record", sourceUrl: "https://example.test/long", mimeType: "application/json", content: { biography: "x".repeat(10_000) }, provenance: {} });
    const result = await store.excerpts({ sourceRef: "S1", queries: ["x"], maxCharacters: 60_000 });
    assert.ok(result.excerpts.every(({ text }) => text.length <= 1_000));
    const reopened = await FileSourceStore.open(directory);
    assert.equal((await reopened.excerpts({ sourceRef: "S1", queries: ["x"], maxCharacters: 60_000 })).excerpts.length > 0, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("inventories every source kind with explicit citation eligibility and pagination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-source-inventory-"));
  try {
    const store = await FileSourceStore.open(directory);
    await store.capture({ kind: "SEARCH_DISCOVERY", provider: "exa", providerRoute: "exa.search", sourceUrl: "https://api.exa.ai/search", mimeType: "application/json", content: { query: "candidate" }, provenance: {}, title: "Search response", date: "2026-08-16", highlight: "Candidate lead" });
    await store.capture({ kind: "SOURCE_CONTENT", provider: "exa", providerRoute: "exa.contents", sourceUrl: "https://example.test/record", mimeType: "text/plain", content: "Authoritative record", provenance: {}, title: "Record", date: "2026-08-15", highlight: "Authoritative" });

    const first = await store.inventory({ limit: 1 });
    assert.deepEqual(first.sources[0], {
      ref: "S1",
      url: "https://api.exa.ai/search",
      title: "Search response",
      date: "2026-08-16",
      route: "exa.search",
      highlight: "Candidate lead",
      sourceKind: "SEARCH_DISCOVERY",
      citationEligible: false,
    });
    assert.equal(first.nextCursor, "S1");
    const second = await store.inventory({ cursor: first.nextCursor ?? undefined });
    assert.equal(second.sources[0]?.ref, "S2");
    assert.equal(second.sources[0]?.citationEligible, true);
    assert.equal(second.nextCursor, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loads historical manifests while ignoring extra semantic fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-source-historical-"));
  try {
    await mkdirForTest(directory);
    const content = "legacy source";
    const digest = (await import("node:crypto")).createHash("sha256").update(content).digest("hex");
    await writeFile(join(directory, "sources", "blobs", `${digest}.txt`), content);
    await writeFile(join(directory, "sources", "manifest.json"), JSON.stringify({ schemaVersion: 1, sources: [{ ref: "S1", kind: "SOURCE_CONTENT", provider: "fixture", providerRoute: "fixture.web.fetch", sourceUrl: "https://example.test/legacy", retrievedAt: "2026-08-14T00:00:00.000Z", sha256: digest, byteLength: content.length, mimeType: "text/plain", relativePath: `sources/blobs/${digest}.txt`, provenance: {}, sourceAuthority: "DIRECT_WORK", independenceGroup: "legacy", canonicalSourceUrl: "https://example.test/legacy" }] }));
    const store = await FileSourceStore.open(directory);
    assert.equal((await store.get("S1")).sourceUrl, "https://example.test/legacy");
    assert.equal("sourceAuthority" in (await store.list())[0]!, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function mkdirForTest(directory: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(directory, "sources", "blobs"), { recursive: true });
}
