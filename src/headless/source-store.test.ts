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
      content: "Opening material. Diego Russo presented the toolchain talk in Cambridge. Closing material.",
      provenance: {},
    });

    const jsonExcerpts = await store.excerpts({ sourceRef: json.ref, queries: ["Principal Engineer"] });
    const textExcerpts = await store.excerpts({ sourceRef: text.ref, queries: ["toolchain"], maxCharacters: 50 });

    assert.deepEqual(jsonExcerpts.excerpts[0], {
      path: "experience[0].title",
      text: "Principal Engineer",
    });
    assert.match(textExcerpts.excerpts[0]!.text, /toolchain/);
    assert.ok(textExcerpts.excerpts[0]!.text.length <= 50);
    assert.equal((await store.readBounded(json.ref, 120)).text, '{\n  "experience": [\n    {\n      "company": "Acme",\n      "title": "Principal Engineer"\n    }\n  ]\n}');
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
