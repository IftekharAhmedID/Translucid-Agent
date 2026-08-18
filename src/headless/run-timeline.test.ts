import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RunTimeline } from "./run-timeline.ts";

test("run timeline preserves authoritative publication order and persisted sequence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-run-timeline-"));
  try {
    const path = join(directory, "run-timeline.jsonl");
    const timeline = new RunTimeline(path);
    await timeline.start();
    await timeline.record({ kind: "publication.provenance.written", status: "OK" });
    await timeline.record({ kind: "publication.audit.pdf.written", status: "OK" });
    await timeline.record({ kind: "publication.report.pdf.written", status: "OK" });
    await timeline.record({ kind: "publication.result.written", status: "OK" });
    await timeline.flush();
    assert.deepEqual(timeline.publicationOrder(), ["publication.provenance.written", "publication.audit.pdf.written", "publication.report.pdf.written", "publication.result.written"]);
    const rows = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { seq: number; kind: string });
    assert.deepEqual(rows.map(({ seq }) => seq), [1, 2, 3, 4, 5]);
    assert.equal(rows.at(-1)?.kind, "publication.result.written");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
