import assert from "node:assert/strict";
import test from "node:test";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { renderInvestigationReport } from "./report.ts";
import type { InvestigationResult } from "./result-contract.ts";

const result: InvestigationResult = {
  schemaVersion: "1.0",
  run: {
    id: "run-report",
    status: "COMPLETED",
    runtime: "LOCAL",
    startedAt: "2026-08-11T12:00:00.000Z",
    finishedAt: "2026-08-11T12:10:00.000Z",
    inputSha256: "a".repeat(64),
    classification: "SYNTHETIC",
    models: { research: "flash", compiler: "pro", auditor: "pro" },
    budgets: { modelUsd: 1, providerUsd: 0, externalNetworkCalls: 1 },
  },
  summary: {
    professionalIdentity: { status: "RESOLVED", text: "The identity is resolved for this synthetic fixture.", claimIds: ["C1"], evidenceIds: ["E1"] },
    professionalTimelineSummary: "The employment record is corroborated.",
    timelineClaimIds: ["C1"],
    timelineEvidenceIds: ["E1"],
    strongestEvidenceByClaim: [{ claimId: "C1", facetKeys: ["title"], evidenceIds: ["E1"] }],
    materialInconsistencies: [],
    limitations: ["Synthetic fixture only."],
  },
  claims: [{
    id: "C1",
    category: "EMPLOYMENT",
    statement: "Synthetic Candidate was Principal Engineer at Example Corp.",
    materiality: "HIGH",
    sourceSpan: { page: 1, text: "Principal Engineer at Example Corp" },
    verdict: "CORROBORATED",
    strength: "STRONG",
    explanation: "Direct work evidence supports the title.",
    facets: [{ key: "title", label: "Title: Principal Engineer", materiality: "HIGH", status: "SUPPORTED", evidenceIds: ["E1"], note: "The source states the title." }],
  }],
  evidence: [{
    id: "E1",
    claimId: "C1",
    facetKeys: ["title"],
    relation: "SUPPORTS",
    sourceRef: "S1",
    exactQuote: "Principal Engineer",
    sourceLocation: { path: "role.title" },
    sourceAuthority: "DIRECT_WORK",
    independenceGroup: "github-repository:example/project",
    attestationGroup: "github-repository:example/project",
  }],
  timeline: [{ label: "Example Corp employment", validFrom: "2020", validTo: "2024", state: "CORROBORATED", claimIds: ["C1"], evidenceIds: ["E1"] }],
  sources: [{
    ref: "S1",
    kind: "SOURCE_CONTENT",
    url: "https://github.com/example/project",
    title: "Example project",
    provider: "github",
    providerRoute: "github.clone",
    retrievedAt: "2026-08-11T12:05:00.000Z",
    sha256: "b".repeat(64),
    byteLength: 100,
    mimeType: "application/json",
    sourceAuthority: "DIRECT_WORK",
    independenceGroup: "github-repository:example/project",
    attestationGroup: "github-repository:example/project",
    relativePath: "sources/blobs/example.json",
  }],
  audit: { status: "PASSED", compilerAttempts: 1, auditorAttempts: 1, warnings: [], statistics: { claims: 1, facets: 1, evidence: 1, sources: 1, rejectedCitations: 0, sourceAuthorityCounts: { DIRECT_WORK: 1 }, providerCalls: 1, cacheHits: 0 } },
};

test("renders deterministic PDF bytes from the canonical result only", async () => {
  const first = await renderInvestigationReport(result);
  const second = await renderInvestigationReport(structuredClone(result));
  assert.deepEqual(second, first);
  assert.equal(first.subarray(0, 5).toString(), "%PDF-");

  const pdf = await getDocument({ data: new Uint8Array(first), disableFontFace: true, useSystemFonts: false }).promise;
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(content.items.flatMap((item) => "str" in item ? [item.str] : []).join(" "));
  }
  assert.match(pages.join("\n"), /Synthetic Candidate was Principal Engineer/);
  assert.match(pages.join("\n"), /Principal Engineer/);
  assert.match(pages.join("\n"), /github\.com\/example\/project/);
});
