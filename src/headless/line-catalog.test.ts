import assert from "node:assert/strict";
import test from "node:test";

import { buildLineCatalog, lineSpan } from "./line-catalog.ts";

test("line catalog preserves source text and assigns stable PDF IDs", () => {
  const catalog = buildLineCatalog({
    pages: [
      { page: 1, lines: [{ line: 1, text: "Candidate" }, { line: 2, text: "1" }, { line: 3, text: "Built systems" }] },
      { page: 2, lines: [{ line: 1, text: "Candidate" }, { line: 2, text: "2" }, { line: 3, text: "Led teams" }] },
    ],
  });

  assert.deepEqual(catalog.lines.map(({ id }) => id), ["P1L1", "P1L2", "P1L3", "P2L1", "P2L2", "P2L3"]);
  assert.equal(catalog.lines.find(({ id }) => id === "P1L2")?.layout, "PAGE_NUMBER");
  assert.equal(catalog.lines.find(({ id }) => id === "P2L1")?.layout, "REPEATED_HEADER");
  assert.equal(catalog.lines.find(({ id }) => id === "P2L2")?.layout, "PAGE_NUMBER");
  assert.equal(catalog.lines.find(({ id }) => id === "P1L3")?.text, "Built systems");
  assert.equal(catalog.lines.filter(({ layout }) => layout === "SEMANTIC").length, 3);
});

test("line span is host-derived and refuses unknown or cross-document IDs", () => {
  const catalog = buildLineCatalog({ pages: [{ page: 1, lines: [{ line: 1, text: "A" }, { line: 2, text: "B" }] }] });
  assert.deepEqual(lineSpan(catalog, ["P1L1", "P1L2"]), { page: 1, text: "A\nB" });
  assert.throws(() => lineSpan(catalog, ["P1L9"]), /Unknown line/);
  assert.throws(() => lineSpan(catalog, []), /at least one/);
});

test("supplemental submission lines receive a separate stable namespace", () => {
  const catalog = buildLineCatalog({ pages: [{ page: 1, lines: [{ line: 1, text: "PDF" }] }], supplementalSubmission: { lines: [{ line: 1, text: "Supplement" }] } });
  assert.deepEqual(catalog.lines.map(({ id }) => id), ["P1L1", "A1L1"]);
  assert.equal(catalog.lines.at(-1)?.origin, "SUPPLEMENT");
});
