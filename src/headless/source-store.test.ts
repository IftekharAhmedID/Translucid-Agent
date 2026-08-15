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
