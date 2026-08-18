import assert from "node:assert/strict";
import test from "node:test";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { renderLeanReport, verifyInvestigationReport } from "./report.ts";
import { leanReportResultSchema, type LeanReportResult } from "./report-store.ts";

const result: LeanReportResult = {
  schemaVersion: 2,
  run: { id: "run-report", status: "COMPLETED", runtime: "LOCAL", startedAt: "2026-08-14T12:00:00.000Z", completedAt: "2026-08-14T12:10:00.000Z", inputSha256: "a".repeat(64), model: "research-model" },
  summary: "The investigation corroborated the current role and found one unresolved education claim.",
  findings: [
    { findingId: "F002", order: 2, section: "Education", claim: "Reported education", anchor: { kind: "PDF_TEXT", page: 2, lineStart: 1, lineEnd: 1, exact: "Education" }, evidence: "No sufficiently specific public record was found.", notes: "The absence of public evidence is not evidence that the claim is false.", status: 0, sources: [] },
    { findingId: "F001", order: 1, section: "Career Experience", claim: "CE-SW Runtimes, Arm Ltd., Cambridge, UK 2023–present — Principal Software Engineer", anchor: { kind: "PDF_TEXT", page: 1, lineStart: 12, lineEnd: 13, exact: "CE-SW Runtimes, Arm Ltd., Cambridge, UK 2023–present\nPrincipal Software Engineer" }, evidence: "The public record consistently identifies the role and interval.", notes: "", status: 2, sources: [{ sourceRef: "S1", title: "Public profile", url: "https://example.com/profile" }] },
  ],
};

test("renders deterministic lean findings in résumé order", async () => {
  const first = await renderLeanReport(result);
  assert.deepEqual(await renderLeanReport(structuredClone(result)), first);
  await assert.doesNotReject(() => verifyInvestigationReport(first));
  const pdf = await getDocument({ data: new Uint8Array(first), disableFontFace: true, useSystemFonts: false }).promise;
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const content = await (await pdf.getPage(pageNumber)).getTextContent();
    pages.push(content.items.flatMap((item) => "str" in item ? [item.str] : []).join(" "));
  }
  const text = pages.join("\n");
  assert.ok(text.indexOf("Career Experience") < text.indexOf("Education"));
  assert.match(text, /Established/);
  assert.match(text, /Unresolved \/ insufficient evidence/);
  assert.match(text, /example\.com\/profile/);
  assert.match(text, /The absence of public evidence/);
});

test("renders enriched v4 conclusions, relation labels, analysis, and discovered findings", async () => {
  const v4: LeanReportResult = {
    schemaVersion: 4,
    run: { id: "run-v4", status: "COMPLETED", runtime: "LOCAL", startedAt: "2026-08-14T12:00:00.000Z", completedAt: "2026-08-14T12:10:00.000Z", inputSha256: "b".repeat(64), model: "deepseek-v4-pro" },
    researchSnapshotSha256: "c".repeat(64),
    summary: "The contribution is established but does not prove leadership.",
    summaryResearchClaimIds: ["leadership", "discovered"],
    findings: [
      {
        findingId: "leadership", order: 1, section: "Career", claim: "Leadership claim", predicate: "Led the project", conclusion: "Leadership is unresolved.",
        anchor: { kind: "PDF_TEXT", page: 1, lineStart: 1, lineEnd: 1, exact: "Candidate" },
        evidence: "CONTEXT — The authored commit establishes contribution, not ownership. [S2]\nCONTRADICTS — No independent record identifies project leadership. [S10]\nSUPPORTS — The profile describes a contributor role. [S3]",
        evidenceEntries: [
          { sourceRef: "S2", relation: "CONTEXT", comment: "The authored commit establishes contribution, not ownership." },
          { sourceRef: "S10", relation: "CONTRADICTS", comment: "No independent record identifies project leadership." },
          { sourceRef: "S3", relation: "SUPPORTS", comment: "The profile describes a contributor role." },
        ],
        rationale: "The evidence distinguishes contribution from leadership.", remainingGap: "An independent ownership record is still needed.", notes: "legacy note", status: -1,
        researchClaimIds: ["leadership"], sources: [{ sourceRef: "S2", title: "Commit", url: "https://example.test/commit" }, { sourceRef: "S10", title: "Search result", url: "https://example.test/leadership" }, { sourceRef: "S3", title: "Profile", url: "https://example.test/profile" }],
      },
      {
        findingId: "discovered", order: 2, section: "Additional", claim: "Discovered fact", predicate: "Co-authored a specification", conclusion: "The discovered authorship is established.",
        anchor: { kind: "DISCOVERED", basis: "An independent primary record made this material to the assessment." },
        evidence: "SUPPORTS — The specification lists the subject as a co-author. [S4]", evidenceEntries: [{ sourceRef: "S4", relation: "SUPPORTS", comment: "The specification lists the subject as a co-author." }],
        rationale: "The independent record directly names the subject.", remainingGap: null, status: 2,
        researchClaimIds: ["discovered"], sources: [{ sourceRef: "S4", title: "Specification", url: "https://example.test/spec" }],
      },
    ],
  } as LeanReportResult;
  const bytes = await renderLeanReport(v4);
  const pdf = await getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false }).promise;
  const text = (await Promise.all(Array.from({ length: pdf.numPages }, async (_, index) => (await (await pdf.getPage(index + 1)).getTextContent()).items.flatMap((item) => "str" in item ? [item.str] : []).join(" ")))).join("\n");
  assert.match(text, /Finding/);
  assert.match(text, /Leadership is unresolved/);
  assert.match(text, /CONTEXT — The authored commit establishes contribution, not ownership/);
  assert.match(text, /An independent ownership record is still needed/);
  assert.match(text, /Additional independently established findings/);
  assert.match(text, /-1: Conflicting evidence/);
  assert.match(text, /2: Established/);
});

test("rejects malformed report bytes before publication", async () => {
  await assert.rejects(() => verifyInvestigationReport(Buffer.from("not a PDF")), /valid PDF/i);
});

test("continues reading the legacy v4 result shape", () => {
  const legacy = {
    schemaVersion: 4,
    run: { id: "legacy-v4", status: "COMPLETED", runtime: "LOCAL", startedAt: "2026-08-14T12:00:00.000Z", completedAt: "2026-08-14T12:10:00.000Z", inputSha256: "d".repeat(64), model: "deepseek-v4-pro" },
    researchSnapshotSha256: "e".repeat(64),
    summary: "Legacy V4 remains inspectable.",
    summaryResearchClaimIds: ["claim"],
    findings: [{ findingId: "claim", order: 1, section: "Career", claim: "A claim", anchor: { kind: "DISCOVERED", basis: "Legacy" }, evidence: "Evidence [S1]", notes: "Notes", status: 0, sources: [], researchClaimIds: ["claim"] }],
  };
  assert.equal(leanReportResultSchema.parse(legacy).schemaVersion, 4);
});
