import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertDossierMatchesDraft, parseEvidenceDossier } from "./dossier.ts";
import { canonicalizeInvestigationResult, type InvestigationDraft } from "./result-contract.ts";
import { loadSourceAuthority } from "./source-authority.ts";
import { FileSourceStore } from "./source-store.ts";

function highCardinalityDraft(sourceRef: string): { draft: InvestigationDraft; sourceRecords: Array<{ text: string }> } {
  const claims: InvestigationDraft["claims"] = [];
  const evidence: InvestigationDraft["evidence"] = [];
  const timeline: InvestigationDraft["timeline"] = [];
  const sourceRecords: Array<{ text: string }> = [];
  for (let index = 0; index < 30; index += 1) {
    const key = `claim-${index}`;
    const evidenceKey = `evidence-${index}`;
    const start = 1990 + index;
    const end = start + 1;
    const statement = `Synthetic Candidate held Role ${index} at Organization ${index} from ${start} to ${end}.`;
    const exactQuote = index === 29 ? `${statement} ${"Extended technical detail. ".repeat(1_000)}` : statement;
    sourceRecords.push({ text: exactQuote });
    const multiFacet = index % 5 === 0;
    const facets = multiFacet
      ? [
        { key: "role", label: `Synthetic Candidate held Role ${index}`, materiality: "HIGH" as const, status: index % 3 === 2 ? "UNRESOLVED" : index % 3 === 1 ? "CONTRADICTED" : "SUPPORTED", note: "Role facet disposition." },
        { key: "employer", label: `Synthetic Candidate worked at Organization ${index}`, materiality: "HIGH" as const, status: index % 3 === 2 ? "UNRESOLVED" : index % 3 === 1 ? "CONTRADICTED" : "SUPPORTED", note: "Employer facet disposition." },
        { key: "tenure", label: `Synthetic Candidate tenure at Organization ${index} from ${start} to ${end}`, materiality: "MEDIUM" as const, status: index % 3 === 2 ? "UNRESOLVED" : index % 3 === 1 ? "CONTRADICTED" : "SUPPORTED", note: "Tenure facet disposition." },
      ]
      : [{ key: "employment", label: `Role ${index} at Organization ${index} from ${start} to ${end}`, materiality: "HIGH" as const, status: index % 3 === 2 ? "UNRESOLVED" : index % 3 === 1 ? "CONTRADICTED" : "SUPPORTED", note: "Employment disposition." }];
    claims.push({
      key,
      category: "EMPLOYMENT",
      statement,
      materiality: index % 7 === 0 ? "MEDIUM" : "HIGH",
      sourceSpan: { page: Math.floor(index / 5) + 1, text: statement },
      explanation: index % 3 === 2 ? "No eligible source resolved this reported employment." : "The immutable source determines the employment disposition.",
      facets,
    });
    if (index % 3 !== 2) {
      evidence.push({
        key: evidenceKey,
        claimKey: key,
        facetKeys: facets.map((facet) => facet.key),
        relation: index % 3 === 1 ? "CONTRADICTS" : "SUPPORTS",
        sourceRef,
        exactQuote,
        sourceLocation: { path: `records[${index}].text` },
      });
    }
    timeline.push({
      label: `Organization ${index} employment`,
      validFrom: `${start}-01-01`,
      validTo: `${end}-12-31`,
      claimKeys: [key],
      evidenceKeys: index % 3 === 2 ? [] : [evidenceKey],
    });
  }
  const evidenceKeys = evidence.map(({ key }) => key);
  return {
    sourceRecords,
    draft: {
      summary: {
        professionalIdentity: { status: "PARTIAL", text: "The synthetic records refer to one test identity.", claimKeys: ["claim-0"], evidenceKeys: ["evidence-0"] },
        professionalTimelineSummary: "The synthetic timeline contains supported, contradicted, and unresolved employment intervals.",
        timelineClaimKeys: claims.map(({ key }) => key),
        timelineEvidenceKeys: evidenceKeys,
        strongestEvidenceByClaim: evidence.map((item) => ({ claimKey: item.claimKey, facetKeys: [...item.facetKeys], evidenceKeys: [item.key] })),
        materialInconsistencies: evidence.filter(({ relation }) => relation === "CONTRADICTS").map((item) => ({ claimKey: item.claimKey, text: "The immutable fixture contradicts this reported interval.", evidenceKeys: [item.key] })),
        limitations: ["Ten synthetic claims intentionally remain unresolved."],
      },
      claims,
      evidence,
      timeline,
    },
  };
}

function dossierText(draft: InvestigationDraft): string {
  return [
    "# Thirty-claim synthetic dossier",
    ...draft.claims.map((claim) => `TL_CLAIM ${JSON.stringify({ key: claim.key, category: claim.category, statement: claim.statement, materiality: claim.materiality, sourceSpan: claim.sourceSpan, explanation: claim.explanation })}`),
    ...draft.claims.flatMap((claim) => claim.facets.map((facet) => `TL_FACET ${JSON.stringify({ claimKey: claim.key, key: facet.key, label: facet.label, materiality: facet.materiality, note: facet.note })}`)),
    ...draft.evidence.map((item) => `TL_EVIDENCE ${JSON.stringify(item)}`),
    `TL_SUMMARY ${JSON.stringify(draft.summary)}`,
    ...draft.timeline.map((item) => `TL_TIMELINE ${JSON.stringify(item)}`),
    ...draft.claims.map((claim, index) => `TL_COVERAGE ${JSON.stringify({ assertion: claim.statement, sourceSpan: claim.sourceSpan, disposition: index % 3 === 2 ? "UNRESOLVED" : "CLAIMED", claimKey: claim.key })}`),
  ].join("\n");
}

test("validates and canonicalizes a lossless thirty-claim mixed-outcome dossier", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-high-cardinality-"));
  try {
    const store = await FileSourceStore.open(directory);
    const source = await store.capture({
      kind: "SOURCE_CONTENT",
      provider: "github",
      providerRoute: "github.clone",
      sourceUrl: "https://github.com/example/high-cardinality-fixture",
      mimeType: "application/json",
      content: { records: highCardinalityDraft("S1").sourceRecords },
      provenance: { networkArguments: { repository: "example/high-cardinality-fixture" } },
    });
    const { draft } = highCardinalityDraft(source.ref);
    const dossier = dossierText(draft);
    const inventory = parseEvidenceDossier(dossier, new Set([source.ref]));
    assert.doesNotThrow(() => assertDossierMatchesDraft(inventory, draft));
    const { snapshot: authoritySnapshot } = await loadSourceAuthority(directory, store);

    const result = await canonicalizeInvestigationResult(draft, {
      run: {
        id: "high-cardinality",
        runtime: "LOCAL",
        startedAt: "2026-08-11T12:00:00.000Z",
        finishedAt: "2026-08-11T12:10:00.000Z",
        inputSha256: "a".repeat(64),
        classification: "SYNTHETIC",
        models: { research: "fixture", compiler: "fixture", auditor: "fixture" },
        budgets: { modelUsd: 0, providerUsd: 0, externalNetworkCalls: 0 },
      },
      sourceStore: store,
      authoritySnapshot,
      compilerAttempts: 1,
      auditorAttempts: 1,
    });
    assert.equal(result.claims.length, 30);
    assert.equal(result.evidence.length, 20);
    assert.equal(result.timeline.length, 30);
    assert.equal(result.claims.filter(({ verdict }) => verdict === "CORROBORATED").length, 10);
    assert.equal(result.claims.filter(({ verdict }) => verdict === "CONTRADICTED").length, 10);
    assert.equal(result.claims.filter(({ verdict }) => verdict === "UNRESOLVED").length, 10);
    assert.ok(result.claims.filter(({ verdict }) => verdict === "UNRESOLVED").every(({ strength }) => strength === null));

    const dropped = structuredClone(draft);
    dropped.evidence.pop();
    assert.throws(() => assertDossierMatchesDraft(inventory, dropped), /evidence semantics/i);
    const fabricated = structuredClone(draft);
    fabricated.evidence.push({ ...fabricated.evidence[0]!, key: "fabricated-evidence" });
    assert.throws(() => assertDossierMatchesDraft(inventory, fabricated), /evidence semantics/i);

    const missingCoverage = dossier.split("\n").filter((line) => !line.includes('"claimKey":"claim-29"') || !line.startsWith("TL_COVERAGE ")).join("\n");
    assert.throws(() => parseEvidenceDossier(missingCoverage, new Set([source.ref])), /claim-29.*coverage/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
