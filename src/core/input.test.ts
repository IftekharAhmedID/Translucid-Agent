import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentInputManifest,
  MAX_PDF_BYTES,
  MAX_SUBMISSION_BYTES,
  normalizeSubmission,
  pdfTextItemsToLines,
  pdfTextItemsToStructuredLines,
  buildPdfSections,
  validatePdfBytes,
  wrapExtractedText,
} from "./input.ts";

test("normalizeSubmission retains raw JSON and creates a stable normalized representation", () => {
  const raw = '{"candidate":{"name":"Synthetic Casey"},"claims":["Built Atlas"]}';
  const result = normalizeSubmission(raw);

  assert.equal(result.kind, "JSON");
  assert.equal(result.raw, raw);
  assert.equal(
    result.normalized,
    '{\n  "candidate": {\n    "name": "Synthetic Casey"\n  },\n  "claims": [\n    "Built Atlas"\n  ]\n}',
  );
});

test("PDF layout separates words with gaps and lines with distinct baselines", () => {
  const item = (str: string, x: number, y: number, width: number, hasEOL = false) => ({ str, transform: [10, 0, 0, 10, x, y], width, height: 10, hasEOL });
  const lines = pdfTextItemsToStructuredLines([
    item("Rice", 10, 100, 20), item("University", 34, 100, 48),
    item("Swing", 10, 80, 25), item("Board", 35, 80, 25, true),
    item("Research", 10, 60, 40, true),
  ]);
  assert.deepEqual(lines.map(({ line, text }) => ({ line, text })), [
    { line: 1, text: "Rice University" }, { line: 2, text: "SwingBoard" }, { line: 3, text: "Research" },
  ]);
  assert.deepEqual(lines[0]?.bounds, [10, 100, 82, 110]);
});

test("structured PDF sections cover numbered lines without reinterpreting claims", () => {
  const pages = [
    { page: 1, lines: ["Candidate Name", "EDUCATION", "Rice University, 2023–2027", "WORKING EXPERIENCE", "Founder, Example"].map((text, index) => ({ line: index + 1, text })) },
    { page: 2, lines: ["More work details", "PUBLICATION", "A research title"].map((text, index) => ({ line: index + 1, text })) },
  ];
  assert.deepEqual(buildPdfSections(pages), [
    { heading: null, ranges: [{ page: 1, lineStart: 1, lineEnd: 1 }] },
    { heading: "EDUCATION", ranges: [{ page: 1, lineStart: 2, lineEnd: 3 }] },
    { heading: "WORKING EXPERIENCE", ranges: [{ page: 1, lineStart: 4, lineEnd: 5 }, { page: 2, lineStart: 1, lineEnd: 1 }] },
    { heading: "PUBLICATION", ranges: [{ page: 2, lineStart: 2, lineEnd: 3 }] },
  ]);
});

test("mixed unsupported PDF geometry falls back to explicit line endings", () => {
  const lines = pdfTextItemsToStructuredLines([
    { str: "left", transform: [10, 0, 0, 10, 10, 100], width: 20, height: 10 },
    { str: " fallback " },
    { str: "right", transform: [10, 0, 0, 10, 10, 80], width: 25, height: 10 },
  ]);
  assert.deepEqual(lines, [{ line: 1, text: "left fallback right" }]);
});

test("normalizeSubmission preserves arbitrary text", () => {
  const raw = "Synthetic candidate submission\nPrincipal Engineer at Acme";
  assert.deepEqual(normalizeSubmission(raw), {
    kind: "TEXT",
    raw,
    normalized: raw,
    byteLength: Buffer.byteLength(raw),
  });
});

test("normalizeSubmission rejects empty and oversized input", () => {
  assert.throws(() => normalizeSubmission("   "), /required/i);
  assert.throws(
    () => normalizeSubmission("x".repeat(MAX_SUBMISSION_BYTES + 1)),
    /1 MiB/i,
  );
});

test("validatePdfBytes checks magic bytes and the 20 MiB limit", () => {
  assert.doesNotThrow(() => validatePdfBytes(Buffer.from("%PDF-1.7\nfixture")));
  assert.throws(() => validatePdfBytes(Buffer.from("not a pdf")), /magic bytes/i);
  assert.throws(
    () => validatePdfBytes(Buffer.alloc(MAX_PDF_BYTES + 1, 1)),
    /20 MiB/i,
  );
});

test("wrapExtractedText keeps all extracted words readable below the OpenCode line limit", () => {
  const extracted = Array.from({ length: 120 }, (_, index) => `claim-${index}`).join(" ");
  const wrapped = wrapExtractedText(extracted, 80);

  assert.equal(wrapped.replace(/\s+/g, " "), extracted);
  assert.ok(wrapped.split("\n").every((line) => line.length <= 80));
  assert.ok(wrapped.split("\n").length > 1);
});

test("pdfTextItemsToLines preserves PDF.js line boundaries instead of flattening a page", () => {
  const lines = pdfTextItemsToLines([
    { str: "Casey Morgan", hasEOL: false },
    { str: " | Principal Software Engineer", hasEOL: true },
    { str: "Career Experience", hasEOL: true },
    { str: "Organization Alpha", hasEOL: false },
    { str: " 2023-present", hasEOL: false },
  ]);

  assert.deepEqual(lines, [
    "Casey Morgan | Principal Software Engineer",
    "Career Experience",
    "Organization Alpha 2023-present",
  ]);
});

test("buildAgentInputManifest strips the raw PDF path and exposes parsed text plus links", () => {
  const manifest = buildAgentInputManifest({
    investigationId: "00000000-0000-4000-8000-000000000001",
    runId: "00000000-0000-4000-8000-000000000002",
    classification: "PUBLIC_PROFESSIONAL",
    submission: { normalizedPath: "/workspace/case/input/submission.normalized.txt" },
    pdfPath: "/workspace/case/input/resume.original.pdf",
    pdfSha256: "abc123",
  }, {
    cleanTextPath: "/workspace/case/input/resume.clean.txt",
    documentPath: "/workspace/case/input/resume.document.json",
    pageCount: 2,
    sparsePageNumbers: [],
    linkCount: 4,
  });

  const serialized = JSON.stringify(manifest);
  assert.equal("pdfPath" in manifest, false);
  assert.doesNotMatch(serialized, /resume\.original\.pdf/);
  assert.match(serialized, /resume\.document\.json/);
  assert.match(serialized, /abc123/);
});
