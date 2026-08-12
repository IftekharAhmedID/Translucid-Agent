import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DOSSIER_PATH,
  FINALIZER_IMPLEMENTATION_VERSION,
  archivePriorFailure,
  loadValidDossierCheckpoint,
  openPersistentRunBudget,
  RESEARCH_CONTRACT_VERSION,
  RESULT_SCHEMA_VERSION,
  researchRuntimeManifestHash,
  validateResearchCheckpoint,
  writeDossierCheckpoint,
  writeResearchCheckpoint,
  type DossierCheckpointConfig,
  type ResearchCheckpointConfig,
} from "./checkpoint.ts";
import { parseEvidenceDossier } from "./dossier.ts";
import { FileSourceStore } from "./source-store.ts";

const hash = (character: string) => character.repeat(64);

const researchConfig: ResearchCheckpointConfig = {
  runtime: "LOCAL",
  providerMode: "fixture",
  researchModel: "research-model",
  runtimeManifestHash: hash("a"),
  researchPromptHash: hash("b"),
  researchSkillBundleHash: hash("c"),
  contractVersion: RESEARCH_CONTRACT_VERSION,
  producingGitCommit: "commit-one",
};

const dossierConfig: DossierCheckpointConfig = {
  compilerModel: "compiler-model",
  resultSchemaVersion: RESULT_SCHEMA_VERSION,
  dossierFormatVersion: "1",
  compilerPromptHash: hash("d"),
  compilerSkillBundleHash: hash("e"),
  finalizerImplementationVersion: FINALIZER_IMPLEMENTATION_VERSION,
  producingGitCommit: "commit-one",
};

const dossier = [
  `TL_CLAIM ${JSON.stringify({ key: "claim", category: "EMPLOYMENT", statement: "Ada worked at Example Corp.", materiality: "HIGH", sourceSpan: { text: "Example Corp" }, explanation: "A source supports the claim." })}`,
  `TL_FACET ${JSON.stringify({ claimKey: "claim", key: "employer", label: "Employer: Example Corp", materiality: "HIGH", note: "The employer is named." })}`,
  `TL_EVIDENCE ${JSON.stringify({ key: "evidence", claimKey: "claim", facetKeys: ["employer"], relation: "SUPPORTS", sourceRef: "S1", exactQuote: "Example Corp", sourceLocation: { path: "company" } })}`,
  `TL_SUMMARY ${JSON.stringify({ professionalIdentity: { status: "PARTIAL", text: "The record is partial.", claimKeys: ["claim"], evidenceKeys: ["evidence"] }, professionalTimelineSummary: "Employment is reported.", timelineClaimKeys: ["claim"], timelineEvidenceKeys: ["evidence"], strongestEvidenceByClaim: [{ claimKey: "claim", facetKeys: ["employer"], evidenceKeys: ["evidence"] }], materialInconsistencies: [], limitations: [] })}`,
  `TL_TIMELINE ${JSON.stringify({ label: "Example employment", claimKeys: ["claim"], evidenceKeys: ["evidence"] })}`,
  `TL_COVERAGE ${JSON.stringify({ assertion: "Ada worked at Example Corp.", sourceSpan: { text: "Example Corp" }, disposition: "CLAIMED", claimKey: "claim" })}`,
].join("\n");

async function fixtureRun(): Promise<{ root: string; store: FileSourceStore }> {
  const root = await mkdtemp(join(tmpdir(), "translucid-checkpoint-"));
  await mkdir(join(root, "input"), { recursive: true });
  await mkdir(join(root, ".work", "memos"), { recursive: true });
  await writeFile(join(root, "input", "document.json"), JSON.stringify({ pages: [{ text: "Example Corp" }] }));
  await writeFile(join(root, ".work", "memos", "specialist.md"), "Finding [S1].");
  const store = await FileSourceStore.open(root);
  await store.capture({ kind: "SOURCE_CONTENT", provider: "fixture", providerRoute: "web.fetch", mimeType: "application/json", content: { company: "Example Corp" }, provenance: {} });
  return { root, store };
}

test("validates targeted research hashes while treating the producing commit as provenance", async () => {
  const { root } = await fixtureRun();
  try {
    await writeResearchCheckpoint(root, {
      warnings: ["lead memo unavailable"],
      budget: { modelUsd: 1, providerUsd: 2, externalNetworkCalls: 1, routeCounts: { "web.fetch": 1 } },
      config: researchConfig,
    });
    const valid = await validateResearchCheckpoint(root, { ...researchConfig, producingGitCommit: "unrelated-new-commit" });
    assert.equal(valid.research.warnings[0], "lead memo unavailable");

    await writeFile(join(root, ".work", "memos", "specialist.md"), "Mutated finding [S1].");
    await assert.rejects(() => validateResearchCheckpoint(root, researchConfig), /artifact hashes/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migrates a preserved full runtime manifest when only finalizer files changed", async () => {
  const { root } = await fixtureRun();
  try {
    const runtimeManifest = {
      node: "v22",
      packages: { "opencode-ai": "1.18.15" },
      files: {
        "runtime/start.sh": hash("d"),
        "runtime/headless-opencode/agents/evidence-compiler.md": hash("c"),
        "runtime/headless-opencode/agents/evidence-auditor.md": hash("a"),
      },
    };
    const fullManifestHash = createHash("sha256").update(JSON.stringify(runtimeManifest)).digest("hex");
    await writeFile(join(root, "runtime-manifest.json"), JSON.stringify({ ...runtimeManifest, manifestHash: fullManifestHash }));
    const legacyConfig = { ...researchConfig, runtimeManifestHash: fullManifestHash };
    await writeResearchCheckpoint(root, {
      warnings: [],
      budget: { modelUsd: 0, providerUsd: 0, externalNetworkCalls: 0, routeCounts: {} },
      config: legacyConfig,
    });
    await assert.doesNotReject(() => validateResearchCheckpoint(root, {
      ...legacyConfig,
      runtimeManifestHash: researchRuntimeManifestHash(runtimeManifest),
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reuses a valid dossier but invalidates only the dossier for compiler changes", async () => {
  const { root } = await fixtureRun();
  try {
    const research = await writeResearchCheckpoint(root, { warnings: [], budget: { modelUsd: 0, providerUsd: 0, externalNetworkCalls: 0, routeCounts: {} }, config: researchConfig });
    await mkdir(join(root, ".work", "finalization"), { recursive: true });
    await writeFile(join(root, DOSSIER_PATH), `${dossier}\n`);
    const inventory = parseEvidenceDossier(dossier, new Set(["S1"]));
    await writeDossierCheckpoint(root, { inventory, config: dossierConfig });

    assert.ok(await loadValidDossierCheckpoint(root, await validateResearchCheckpoint(root, researchConfig), { ...dossierConfig, producingGitCommit: "new-commit" }));
    assert.equal(await loadValidDossierCheckpoint(root, research, { ...dossierConfig, compilerModel: "new-compiler" }), undefined);
    await validateResearchCheckpoint(root, researchConfig);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restores and atomically advances a persisted cumulative budget", async () => {
  const { root } = await fixtureRun();
  try {
    const ceilings = { modelUsd: 5, providerUsd: 10, externalNetworkCalls: 5, repositoryClones: 3, socialProfiles: 1 };
    const first = await openPersistentRunBudget(root, ceilings, { modelUsd: 1, providerUsd: 2, externalNetworkCalls: 1, routeCounts: { "web.fetch": 1 } });
    await first.reserveModel(0.5);
    await first.flush();
    const resumed = await openPersistentRunBudget(root, ceilings);
    assert.equal(resumed.snapshot().modelUsd, 1.5);
    assert.equal((JSON.parse(await readFile(join(root, ".work", "finalization", "budget.json"), "utf8")) as { modelUsd: number }).modelUsd, 1.5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archives a prior failure before a finalization retry", async () => {
  const { root } = await fixtureRun();
  try {
    await writeFile(join(root, "failure.json"), JSON.stringify({ code: "OLD_FAILURE" }));
    const archived = await archivePriorFailure(root, new Date("2026-08-11T12:00:00.000Z"));
    assert.ok(archived);
    assert.deepEqual(JSON.parse(await readFile(archived, "utf8")), { code: "OLD_FAILURE" });
    await assert.rejects(() => readFile(join(root, "failure.json")), /ENOENT/);
    assert.equal(await archivePriorFailure(root), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
