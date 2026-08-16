import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { persistResearchLedger, persistResearchMemo, persistResearchNotebook, verifyResearchSnapshot, writeResearchSnapshot } from "./recovery.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

test("persists a completed sandbox memo to the host with safe host-derived paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-host-memo-"));
  try {
    await persistResearchLedger(root, {
      role: "github-researcher",
      sessionId: "ses_123",
      encounteredSourceRefs: ["S1", "S2"],
      entries: [{ sourceRef: "S1", disposition: "EVIDENCE", relevance: "identity", sourceFamily: "official", claimLane: "identity" }],
    });
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
    assert.equal(metadata.schemaVersion, 2);
    assert.equal(metadata.memoSha256, sha256("# github-researcher memo\n\nSession: ses_123\n\nFinding [S1].\n"));
    await assert.rejects(persistResearchMemo(root, { role: "../../escape", wave: "INITIAL", sessionId: "ses_123", memo: "x", encounteredSourceRefs: [], citedSourceRefs: [] }), /invalid/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists a bounded notebook and a separate compaction recovery summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-notebook-"));
  try {
    const recovery = [
      "## Active claim lanes\nS1 identity",
      "## Strongest source refs\nS1",
      "## Contradictions\nnone",
      "## Unresolved material facets\ncurrent role",
      "## Current search leads\nemployer page",
      "## Next actions\ncheck dates",
      "## Stop decisions\nnone",
    ].join("\n\n");
    const result = await persistResearchNotebook(root, {
      markdown: "# Investigation\n\n" + "evidence ".repeat(100),
      recoverySummary: recovery,
    });
    assert.equal(result.ok, true);
    assert.equal(JSON.parse(JSON.stringify(result)).recoveryByteLength, Buffer.byteLength(recovery));
    assert.match(await readFile(join(root, ".work", "investigation.md"), "utf8"), /evidence/);
    assert.match(await readFile(join(root, ".work", "investigation-recovery.md"), "utf8"), /Active claim lanes/);
    await assert.rejects(persistResearchNotebook(root, { markdown: "x", recoverySummary: "## Active claim lanes\nmissing headings" }), /headings/i);
    await assert.rejects(persistResearchNotebook(root, { markdown: "x".repeat(100 * 1024 + 1), recoverySummary: recovery }), /100 KiB/i);
    await assert.rejects(persistResearchNotebook(root, { markdown: "x", recoverySummary: `${recovery}\n${"x".repeat(16 * 1024)}` }), /16 KiB/i);
    await assert.rejects(persistResearchNotebook(root, { markdown: "S0", recoverySummary: recovery }), /invalid source reference/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upserts session-owned evidence ledgers and rejects unencountered refs", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-ledger-"));
  try {
    const first = await persistResearchLedger(root, {
      role: "professional-researcher",
      sessionId: "ses_123",
      encounteredSourceRefs: ["S1", "S2"],
      entries: [{ sourceRef: "S1", disposition: "LEAD", relevance: "dates", sourceFamily: "employer", claimLane: "chronology" }],
    });
    assert.equal(first.ok, true);
    const second = await persistResearchLedger(root, {
      role: "professional-researcher",
      sessionId: "ses_123",
      encounteredSourceRefs: ["S1", "S2"],
      entries: [{ sourceRef: "S1", disposition: "EVIDENCE", relevance: "dates", sourceFamily: "employer", claimLane: "chronology" }, { sourceRef: "S2", disposition: "CONTEXT", relevance: "identity", sourceFamily: "directory", claimLane: "identity" }],
    });
    assert.equal(second.entryCount, 2);
    const ledger = JSON.parse(await readFile(join(root, ".work", "evidence-ledgers", "professional-researcher-ses_123.json"), "utf8"));
    assert.equal(ledger.entries[0].disposition, "EVIDENCE");
    await assert.rejects(persistResearchLedger(root, {
      role: "professional-researcher",
      sessionId: "ses_123",
      encounteredSourceRefs: ["S1"],
      entries: [{ sourceRef: "S99", disposition: "EVIDENCE", relevance: "unknown", sourceFamily: "unknown", claimLane: "unknown" }],
    }), /encountered/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writes and verifies the minimal durable research snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-research-snapshot-"));
  try {
    await mkdir(join(root, "input"), { recursive: true });
    await mkdir(join(root, "sources", "blobs"), { recursive: true });
    await mkdir(join(root, ".work", "memos"), { recursive: true });
    await writeFile(join(root, "input", "manifest.json"), "input manifest");
    await writeFile(join(root, "input", "document.json"), "document");
    await writeFile(join(root, "sources", "manifest.json"), "source manifest");
    await writeFile(join(root, "sources", "blobs", "source.txt"), "source blob");
    await writeFile(join(root, ".work", "memos", "lead.md"), "lead memo");

    await writeResearchSnapshot(root, { runtime: "LOCAL", researchModel: "research-model" });
    const verified = await verifyResearchSnapshot(root);
    assert.equal(verified.runtime, "LOCAL");
    assert.equal(verified.researchModel, "research-model");
    assert.ok(verified.artifactCount >= 5);

    await writeFile(join(root, ".work", "memos", "lead.md"), "tampered");
    await assert.rejects(verifyResearchSnapshot(root), /hash differs.*lead\.md/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verifies the existing historical handoff without requiring its stale runtime configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-historical-snapshot-"));
  try {
    await mkdir(join(root, ".work", "finalization"), { recursive: true });
    await mkdir(join(root, ".work", "memos"), { recursive: true });
    await writeFile(join(root, ".work", "memos", "lead.md"), "historical memo");
    await writeFile(join(root, ".work", "finalization", "handoff-manifest.json"), JSON.stringify({
      schemaVersion: 1,
      research: {
        artifacts: { ".work/memos/lead.md": sha256("historical memo") },
        config: { runtime: "E2B", researchModel: "historical-model", runtimeManifestHash: "stale" },
      },
    }));

    assert.deepEqual(await verifyResearchSnapshot(root), { runtime: "E2B", researchModel: "historical-model", artifactCount: 1, source: "HISTORICAL_HANDOFF" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
