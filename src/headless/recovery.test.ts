import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { persistResearchMemo, verifyResearchSnapshot, writeResearchSnapshot } from "./recovery.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

test("persists a completed sandbox memo to the host with safe host-derived paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-host-memo-"));
  try {
    const result = await persistResearchMemo(root, {
      role: "github-researcher",
      wave: "INITIAL",
      sessionId: "ses_123",
      memo: "# github-researcher memo\n\nSession: ses_123\n\nFinding [S1].\n",
      encounteredSourceRefs: ["S1", "S2"],
      citedSourceRefs: ["S1"],
    });
    assert.equal(result.ok, true);
    assert.match(await readFile(join(root, ".work", "memos", "github-researcher-ses_123.md"), "utf8"), /Finding \[S1\]/);
    const metadata = JSON.parse(await readFile(join(root, ".work", "memos", "github-researcher-ses_123.sources.json"), "utf8"));
    assert.equal(metadata.memoSha256, sha256("# github-researcher memo\n\nSession: ses_123\n\nFinding [S1].\n"));
    await assert.rejects(persistResearchMemo(root, { role: "../../escape", wave: "INITIAL", sessionId: "ses_123", memo: "x", encounteredSourceRefs: [], citedSourceRefs: [] }), /invalid/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writes and verifies the minimal durable research snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-research-snapshot-"));
  try {
    await mkdir(join(root, "input"), { recursive: true });
    await mkdir(join(root, "sources"), { recursive: true });
    await mkdir(join(root, ".work", "memos"), { recursive: true });
    await writeFile(join(root, "input", "manifest.json"), "input manifest");
    await writeFile(join(root, "input", "document.json"), "document");
    await writeFile(join(root, "sources", "manifest.json"), "source manifest");
    await writeFile(join(root, ".work", "memos", "lead.md"), "lead memo");

    await writeResearchSnapshot(root, { runtime: "LOCAL", researchModel: "research-model" });
    const verified = await verifyResearchSnapshot(root);
    assert.equal(verified.runtime, "LOCAL");
    assert.equal(verified.researchModel, "research-model");
    assert.equal(verified.artifactCount, 4);

    await writeFile(join(root, ".work", "memos", "lead.md"), "tampered");
    await assert.rejects(verifyResearchSnapshot(root), /hash differs.*lead\.md/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verifies the existing legacy handoff without requiring its stale runtime configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-legacy-snapshot-"));
  try {
    await mkdir(join(root, ".work", "finalization"), { recursive: true });
    await mkdir(join(root, ".work", "memos"), { recursive: true });
    await writeFile(join(root, ".work", "memos", "lead.md"), "legacy memo");
    await writeFile(join(root, ".work", "finalization", "handoff-manifest.json"), JSON.stringify({
      schemaVersion: 1,
      research: {
        artifacts: { ".work/memos/lead.md": sha256("legacy memo") },
        config: { runtime: "E2B", researchModel: "legacy-model", runtimeManifestHash: "stale" },
      },
    }));

    assert.deepEqual(await verifyResearchSnapshot(root), { runtime: "E2B", researchModel: "legacy-model", artifactCount: 1, source: "LEGACY_HANDOFF" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
