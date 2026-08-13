import assert from "node:assert/strict";
import test from "node:test";

import { buildLineCatalog } from "./line-catalog.ts";
import { claimBatchSchema, evidenceJudgmentSchema, validateClaimBatch, validateClaimBatchRecords, validateEvidenceJudgment } from "./incremental-finalization.ts";

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

test("claim records preserve valid disjoint siblings when one candidate is malformed", () => {
  const result = validateClaimBatchRecords({ claims: [
    { localKey: "identity", category: "IDENTITY", statement: "The résumé identifies Ada Lovelace.", materiality: "HIGH", facets: [{ key: "name", label: "The person is Ada Lovelace.", materiality: "HIGH", lineIds: ["P1L1"] }] },
    { localKey: "broken", category: "EMPLOYMENT", statement: "Broken", materiality: "URGENT", facets: [{ key: "title", label: "Ada held the Principal Engineer title.", materiality: "HIGH", lineIds: ["P1L2"] }] },
  ], exclusions: [{ lineIds: ["P1L3"], reason: "BARE_SKILL" }], deferredLineIds: [] }, catalog, ["P1L1", "P1L2", "P1L3"]);
  assert.deepEqual(result.claims.map(({ claimKey }) => claimKey), ["C001"]);
  assert.deepEqual(result.unresolvedLineIds, ["P1L2"]);
  assert.match(result.defects.join("\n"), /broken/i);
});

test("evidence judgment accounts for every assigned candidate including irrelevant evidence", () => {
  const claim = { claimKey: "C001", facets: [{ key: "title" }] };
  const excerpt = { ref: `X${"a".repeat(64)}`, sourceRef: "S1", path: "$", offsetStart: 0, offsetEnd: 4, text: "fact" };
  const valid = validateEvidenceJudgment({ claimId: "C001", candidateSetHash: "b".repeat(64), facets: [{ facetKey: "title", candidates: [{ excerptRef: excerpt.ref, relation: "IRRELEVANT", reason: "The excerpt does not establish the title." }] }] }, claim, new Map([["title", [excerpt]]]));
  assert.equal(valid.facets[0]!.candidates[0]!.relation, "IRRELEVANT");
  assert.throws(() => validateEvidenceJudgment({ ...valid, facets: [{ facetKey: "title", candidates: [] }] }, claim, new Map([["title", [excerpt]]])), /exactly account/);
  assert.throws(() => validateEvidenceJudgment({ ...valid, facets: [{ facetKey: "title", candidates: [{ excerptRef: `X${"c".repeat(64)}`, relation: "SUPPORTS", reason: "unknown" }] }] }, claim, new Map([["title", [excerpt]]])), /unknown excerpt/);
  assert.doesNotThrow(() => evidenceJudgmentSchema.parse(valid));
});

test("claim schema remains strict and bounded to five claims", () => {
  assert.throws(() => claimBatchSchema.parse({ claims: Array.from({ length: 6 }, (_, index) => ({ localKey: `c${index}`, category: "OTHER", statement: "x", materiality: "LOW", facets: [{ key: "x", label: "x", materiality: "LOW", lineIds: ["P1L1"] }] })), exclusions: [], deferredLineIds: [] }), /Too big/);
});
