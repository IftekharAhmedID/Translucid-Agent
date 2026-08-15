import assert from "node:assert/strict";
import test from "node:test";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { renderLeanReport, verifyInvestigationReport } from "./report.ts";
import type { LeanReportResult } from "./report-store.ts";

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
  assert.match(text, /Fully corroborated/);
  assert.match(text, /Unclear or insufficient credible public evidence/);
  assert.match(text, /example\.com\/profile/);
  assert.match(text, /The absence of public evidence/);
});

test("rejects malformed report bytes before publication", async () => {
  await assert.rejects(() => verifyInvestigationReport(Buffer.from("not a PDF")), /valid PDF/i);
});
