import assert from "node:assert/strict";
import test from "node:test";
import { evidenceScore, renderTextReport } from "./text-report.ts";

test("only submitted claims affect the evidence score and unresolved evidence lowers it", () => {
  const findings = [
    { status: 2, anchor: { kind: "PDF_TEXT" } },
    { status: 1, anchor: { kind: "PDF_TEXT" } },
    { status: 0, anchor: { kind: "PDF_TEXT" } },
    { status: 2, anchor: { kind: "DISCOVERED" } },
  ];
  assert.deepEqual(evidenceScore(findings), { score: 50, claims: 3, established: 1, partial: 1, unresolved: 1, conflicting: 0, contradicted: 0 });
  assert.equal(evidenceScore([]).score, null);
});

test("plain report contains findings, gaps and source URLs without markup or process logs", () => {
  const text = renderTextReport({ summary: "Some support found.", findings: [{ section: "Work", claim: "Built a project", status: 1, anchor: { kind: "PDF_TEXT" }, evidence: "A commit exists.", remainingGap: "Ownership unknown.", sources: [{ sourceRef: "S1", title: "Repository", url: "https://example.org/repo" }] }] });
  assert.match(text, /50\/100/);
  assert.match(text, /Ownership unknown/);
  assert.match(text, /https:\/\/example.org\/repo/);
  assert.doesNotMatch(text, /<html|research\.started/);
});

test("v4 reports retain assertion-level evidence and rationale alongside the conclusion", () => {
  const report = renderTextReport({ summary: "Summary", findings: [{ status: 1, anchor: { kind: "PDF_TEXT" }, conclusion: "A contribution is supported.", rationale: "The public record shows a commit.", evidenceEntries: [{ sourceRef: "S1", relation: "SUPPORTS", comment: "The commit supports contribution, not ownership." }] }] });
  assert.match(report, /supports contribution, not ownership/);
  assert.match(report, /public record shows a commit/);
});
