import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PDF_BYTES,
  MAX_SUBMISSION_BYTES,
  normalizeSubmission,
  validatePdfBytes,
} from "./input.ts";

test("normalizeSubmission retains raw JSON and creates a stable normalized representation", () => {
  const raw = '{"candidate":{"name":"Synthetic Ada"},"claims":["Built Atlas"]}';
  const result = normalizeSubmission(raw);

  assert.equal(result.kind, "JSON");
  assert.equal(result.raw, raw);
  assert.equal(
    result.normalized,
    '{\n  "candidate": {\n    "name": "Synthetic Ada"\n  },\n  "claims": [\n    "Built Atlas"\n  ]\n}',
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
