import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalizeInvestigationResult, type InvestigationDraft } from "./result-contract.ts";
import { FileSourceStore } from "./source-store.ts";

const run = {
  id: "run-test",
  runtime: "LOCAL" as const,
  startedAt: "2026-08-11T12:00:00.000Z",
  finishedAt: "2026-08-11T12:10:00.000Z",
  inputSha256: "a".repeat(64),
  classification: "SYNTHETIC" as const,
  models: { research: "flash", compiler: "pro", auditor: "pro" },
  budgets: { modelUsd: 1.25, providerUsd: 0.5, externalNetworkCalls: 2 },
};

function draft(sourceRef: string): InvestigationDraft {
  return {
    summary: {
      professionalIdentity: {
        status: "RESOLVED",
        text: "The professional identity is consistently represented.",
        claimKeys: ["employment"],
        evidenceKeys: ["employment-title", "employment-team"],
      },
      professionalTimelineSummary: "The captured record supports the reported Arm employment.",
      timelineClaimKeys: ["employment"],
      timelineEvidenceKeys: ["employment-title", "employment-team"],
      strongestEvidenceByClaim: [{
        claimKey: "employment",
        facetKeys: ["title", "employer_team"],
        evidenceKeys: ["employment-title", "employment-team"],
      }],
      materialInconsistencies: [],
      limitations: [],
    },
    claims: [{
      key: "employment",
      category: "EMPLOYMENT",
      statement: "Diego Russo worked as Staff Software Engineer in DSG at Arm Ltd.",
      materiality: "HIGH",
      sourceSpan: { page: 1, text: "Staff Software Engineer, DSG, Arm Ltd" },
      explanation: "Direct repository records align with the reported role and team.",
      facets: [
        { key: "employer_team", label: "Employer/team: Arm Ltd, DSG", materiality: "HIGH", status: "SUPPORTED", note: "The source names Arm Ltd and DSG." },
        { key: "title", label: "Title: Staff Software Engineer", materiality: "HIGH", status: "SUPPORTED", note: "The source states the title." },
      ],
    }],
    evidence: [
      {
        key: "employment-title",
        claimKey: "employment",
        facetKeys: ["title"],
        relation: "SUPPORTS",
        sourceRef,
        exactQuote: "Staff Software Engineer",
        sourceLocation: { path: "role.title" },
      },
      {
        key: "employment-team",
        claimKey: "employment",
        facetKeys: ["employer_team"],
        relation: "SUPPORTS",
        sourceRef,
        exactQuote: "Arm Ltd, DSG",
        sourceLocation: { path: "role.team" },
      },
    ],
    timeline: [{
      label: "Arm Ltd employment",
      validFrom: "2013",
      validTo: "2017",
      claimKeys: ["employment"],
      evidenceKeys: ["employment-title", "employment-team"],
    }],
  };
}

async function directWorkStore(directory: string): Promise<{ store: FileSourceStore; sourceRef: string }> {
  const store = await FileSourceStore.open(directory);
  const source = await store.capture({
    kind: "SOURCE_CONTENT",
    provider: "github",
    providerRoute: "github.clone",
    sourceUrl: "https://github.com/example/toolchain",
    mimeType: "application/json",
    content: { role: { title: "Staff Software Engineer", team: "Arm Ltd, DSG" } },
    provenance: { networkArguments: { repository: "example/toolchain" } },
    retrievedAt: "2026-08-11T12:05:00.000Z",
  });
  return { store, sourceRef: source.ref };
}

test("canonicalizes semantic keys and derives facet outcomes, trust, timeline state, and audit counts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-result-"));
  try {
    const { store, sourceRef } = await directWorkStore(directory);
    const result = await canonicalizeInvestigationResult(draft(sourceRef), {
      run,
      sourceStore: store,
      compilerAttempts: 1,
      auditorAttempts: 1,
      rejectedCitations: 0,
      providerCalls: 2,
      cacheHits: 1,
    });

    assert.equal(result.claims[0]?.id, "C1");
    assert.equal(result.claims[0]?.verdict, "CORROBORATED");
    assert.equal(result.claims[0]?.strength, "STRONG");
    assert.deepEqual(result.claims[0]?.facets.map(({ evidenceIds }) => evidenceIds), [["E1"], ["E2"]]);
    assert.deepEqual(result.evidence.map(({ id, claimId, sourceAuthority, attestationGroup }) => ({ id, claimId, sourceAuthority, attestationGroup })), [
      { id: "E1", claimId: "C1", sourceAuthority: "DIRECT_WORK", attestationGroup: "github-repository:example/toolchain" },
      { id: "E2", claimId: "C1", sourceAuthority: "DIRECT_WORK", attestationGroup: "github-repository:example/toolchain" },
    ]);
    assert.equal(result.timeline[0]?.state, "CORROBORATED");
    assert.deepEqual(result.summary.professionalIdentity.claimIds, ["C1"]);
    assert.deepEqual(result.summary.professionalIdentity.evidenceIds, ["E2", "E1"]);
    assert.deepEqual(result.audit.statistics, {
      claims: 1,
      facets: 2,
      evidence: 2,
      sources: 1,
      rejectedCitations: 0,
      sourceAuthorityCounts: { DIRECT_WORK: 2 },
      providerCalls: 2,
      cacheHits: 1,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a quote that does not exist in the immutable source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-result-quote-"));
  try {
    const { store, sourceRef } = await directWorkStore(directory);
    const invalid = draft(sourceRef);
    invalid.evidence[0]!.exactQuote = "Staff Software Engineer II";
    await assert.rejects(
      canonicalizeInvestigationResult(invalid, { run, sourceStore: store, compilerAttempts: 1, auditorAttempts: 1 }),
      /exact quote.*not present/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects neighboring-facet evidence and context citations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-result-scope-"));
  try {
    const { store, sourceRef } = await directWorkStore(directory);
    const neighboring = draft(sourceRef);
    neighboring.evidence[0]!.facetKeys = ["employer_team"];
    await assert.rejects(
      canonicalizeInvestigationResult(neighboring, { run, sourceStore: store, compilerAttempts: 1, auditorAttempts: 1 }),
      /incompatible with facet employer_team/i,
    );

    const contextStore = await FileSourceStore.open(join(directory, "context"));
    const context = await contextStore.capture({
      kind: "SOURCE_CONTENT",
      provider: "exa",
      providerRoute: "exa.contents",
      sourceUrl: "https://unknown.example/profile",
      mimeType: "application/json",
      content: { role: { title: "Staff Software Engineer", team: "Arm Ltd, DSG" } },
      provenance: {},
    });
    await assert.rejects(
      canonicalizeInvestigationResult(draft(context.ref), { run, sourceStore: contextStore, compilerAttempts: 1, auditorAttempts: 1 }),
      /CONTEXT.*cannot be cited/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects summary evidence that crosses claim boundaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-result-summary-"));
  try {
    const { store, sourceRef } = await directWorkStore(directory);
    const invalid = draft(sourceRef);
    invalid.claims.push({
      key: "education",
      category: "EDUCATION",
      statement: "Diego Russo completed a degree at Example University.",
      materiality: "MEDIUM",
      sourceSpan: { page: 2, text: "Example University" },
      explanation: "No eligible source was captured.",
      facets: [{ key: "institution", label: "Institution: Example University", materiality: "MEDIUM", status: "UNRESOLVED", note: "No eligible source." }],
    });
    invalid.summary.strongestEvidenceByClaim = [{ claimKey: "education", facetKeys: ["institution"], evidenceKeys: ["employment-title"] }];

    await assert.rejects(
      canonicalizeInvestigationResult(invalid, { run, sourceStore: store, compilerAttempts: 1, auditorAttempts: 1 }),
      /does not belong to claim education/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects an unresolved facet when eligible evidence already exists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-result-unresolved-"));
  try {
    const { store, sourceRef } = await directWorkStore(directory);
    const invalid = draft(sourceRef);
    invalid.claims[0]!.facets[0]!.status = "UNRESOLVED";
    await assert.rejects(
      canonicalizeInvestigationResult(invalid, { run, sourceStore: store, compilerAttempts: 1, auditorAttempts: 1 }),
      /facet employer_team.*must be SUPPORTED/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a material claim clause that has no declared facet", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-result-coverage-"));
  try {
    const { store, sourceRef } = await directWorkStore(directory);
    const invalid = draft(sourceRef);
    invalid.claims[0]!.statement += " He also led twelve engineers.";
    invalid.claims[0]!.sourceSpan.text += " Led twelve engineers.";

    await assert.rejects(
      canonicalizeInvestigationResult(invalid, { run, sourceStore: store, compilerAttempts: 1, auditorAttempts: 1 }),
      /material claim clause.*led twelve engineers/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
