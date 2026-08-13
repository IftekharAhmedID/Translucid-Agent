import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentInputManifest,
  MAX_PDF_BYTES,
  MAX_SUBMISSION_BYTES,
  normalizeSubmission,
  pdfTextItemsToLines,
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
