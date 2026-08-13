import assert from "node:assert/strict";
import test from "node:test";

import { buildLineCatalog } from "./line-catalog.ts";
import { claimBatchSchema, validateClaimBatch, validateEvidenceBatch } from "./incremental-finalization.ts";

const catalog = buildLineCatalog({ pages: [{ page: 1, lines: [
  { line: 1, text: "Ada Lovelace" },
  { line: 2, text: "Principal Engineer at Example Corp" },
  { line: 3, text: "Python" },
] }] });

test("claim batch validates line ownership and derives host facts", () => {
  const batch = {
    claims: [
      { localKey: "identity", category: "IDENTITY", statement: "The résumé identifies Ada Lovelace.", materiality: "HIGH", facets: [{ key: "name", label: "The person is Ada Lovelace.", materiality: "HIGH", lineIds: ["P1L1"] }] },
      { localKey: "employment", category: "EMPLOYMENT", statement: "Ada held a principal engineering role at Example Corp.", materiality: "HIGH", facets: [
      { key: "title", label: "Ada held the title Principal Engineer.", materiality: "HIGH", lineIds: ["P1L2"] },
      { key: "employer", label: "Ada worked at Example Corp.", materiality: "HIGH", lineIds: ["P1L2"] },
    ] }],
    exclusions: [{ lineIds: ["P1L3"], reason: "BARE_SKILL" }],
    deferredLineIds: [],
  };
  const validated = validateClaimBatch(batch, catalog, ["P1L1", "P1L2", "P1L3"]);
  assert.equal(validated.claims[1]!.sourceSpan.text, "Principal Engineer at Example Corp");
  assert.equal(validated.claims[1]!.sourceSpan.page, 1);
  assert.deepEqual(validated.exclusions[0]!.lineIds, ["P1L3"]);
});

test("claim validation rejects duplicate ownership and zero progress", () => {
  const invalid = { claims: [], exclusions: [], deferredLineIds: ["P1L1", "P1L2"] };
  assert.throws(() => validateClaimBatch(invalid, catalog, ["P1L1", "P1L2"]), /earliest unresolved line/);
  const duplicate = { claims: [{ localKey: "a", category: "OTHER", statement: "A", materiality: "LOW", facets: [{ key: "a", label: "A fact", materiality: "LOW", lineIds: ["P1L1"] }] }], exclusions: [{ lineIds: ["P1L1"], reason: "NON_ASSERTIVE" }], deferredLineIds: [] };
  assert.throws(() => validateClaimBatch(duplicate, catalog, ["P1L1"]), /more than one disposition/);
});

test("evidence validation accepts only known excerpt references and claim facets", () => {
  const claim = { claimKey: "C001", facets: [{ key: "title" }] };
  const excerpt = { ref: `X${"a".repeat(64)}`, sourceRef: "S1", path: "$", offsetStart: 0, offsetEnd: 4, text: "fact" };
  const valid = validateEvidenceBatch({ claims: [{ claimId: "C001", explanation: "fact", facetNotes: [{ facetKey: "title", note: "fact" }], edges: [{ facetKeys: ["title"], relation: "SUPPORTS", excerptRef: excerpt.ref }] }] }, [claim], new Map([[excerpt.ref, excerpt]]));
  assert.equal(valid.claims[0]!.edges[0]!.excerptRef, excerpt.ref);
  assert.throws(() => validateEvidenceBatch({ claims: [{ ...valid.claims[0]!, edges: [{ ...valid.claims[0]!.edges[0]!, excerptRef: `X${"b".repeat(64)}` }] }] }, [claim], new Map([[excerpt.ref, excerpt]])), /unknown excerpt/);
});

test("claim schema remains strict and bounded to five claims", () => {
  assert.throws(() => claimBatchSchema.parse({ claims: Array.from({ length: 6 }, (_, index) => ({ localKey: `c${index}`, category: "OTHER", statement: "x", materiality: "LOW", facets: [{ key: "x", label: "x", materiality: "LOW", lineIds: ["P1L1"] }] })), exclusions: [], deferredLineIds: [] }), /Too big/);
});
