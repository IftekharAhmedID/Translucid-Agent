import assert from "node:assert/strict";
import test from "node:test";

import { buildLineCatalog } from "./line-catalog.ts";
import { claimBatchSchema, evidenceJudgmentSchema, invalidatedFinalizationStages, v5FacetEvidenceCompatible, validateClaimBatchRecords, validateEvidenceJudgment } from "./incremental-finalization.ts";

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
  const validated = validateClaimBatchRecords(batch, catalog, ["P1L1", "P1L2", "P1L3"]);
  assert.deepEqual(validated.defects, []);
  assert.deepEqual(validated.unresolvedLineIds, []);
  assert.equal(validated.claims[1]!.sourceSpan.text, "Principal Engineer at Example Corp");
  assert.equal(validated.claims[1]!.sourceSpan.page, 1);
  assert.deepEqual(validated.exclusions[0]!.lineIds, ["P1L3"]);
});

test("claim validation rejects duplicate ownership and zero progress", () => {
  const invalid = { claims: [], exclusions: [], deferredLineIds: ["P1L1", "P1L2"] };
  assert.deepEqual(validateClaimBatchRecords(invalid, catalog, ["P1L1", "P1L2"]).unresolvedLineIds, ["P1L1"]);
  const duplicate = { claims: [{ localKey: "a", category: "OTHER", statement: "Ada Lovelace is identified.", materiality: "LOW", facets: [{ key: "a", label: "The person is Ada Lovelace.", materiality: "LOW", lineIds: ["P1L1"] }] }], exclusions: [{ lineIds: ["P1L1"], reason: "NON_ASSERTIVE" }], deferredLineIds: [] };
  assert.match(validateClaimBatchRecords(duplicate, catalog, ["P1L1"]).defects.join("\n"), /more than one disposition/);
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

test("claim records reject non-atomic facets before freezing siblings", () => {
  const result = validateClaimBatchRecords({ claims: [{
    localKey: "compound",
    category: "EMPLOYMENT",
    statement: "Ada worked at Example Corp and organized EuroPython 2024.",
    materiality: "HIGH",
    facets: [{ key: "employment", label: "Ada worked at Example Corp.", materiality: "HIGH", lineIds: ["P1L2"] }],
  }], exclusions: [], deferredLineIds: [] }, catalog, ["P1L2"]);
  assert.deepEqual(result.claims, []);
  assert.deepEqual(result.unresolvedLineIds, ["P1L2"]);
  assert.match(result.defects.join("\n"), /no facet/i);
});

test("claim record validation leaves an earliest deferral unresolved for the bounded repair", () => {
  const result = validateClaimBatchRecords({
    claims: [{ localKey: "employment", category: "EMPLOYMENT", statement: "Ada held a principal engineering role.", materiality: "HIGH", facets: [{ key: "title", label: "Ada held the title Principal Engineer.", materiality: "HIGH", lineIds: ["P1L2"] }] }],
    exclusions: [],
    deferredLineIds: ["P1L1", "P1L3"],
  }, catalog, ["P1L1", "P1L2", "P1L3"]);

  assert.deepEqual(result.claims.map(({ claimKey }) => claimKey), ["C001"]);
  assert.deepEqual(result.deferredLineIds, ["P1L3"]);
  assert.deepEqual(result.unresolvedLineIds, ["P1L1"]);
  assert.match(result.defects.join("\n"), /earliest unresolved line/i);
});

test("evidence judgment accounts for every assigned candidate including irrelevant evidence", () => {
  const claim = { claimKey: "C001", facets: [{ key: "title" }] };
  const excerpt = { ref: `X${"a".repeat(64)}`, sourceRef: "S1", path: "$", offsetStart: 0, offsetEnd: 4, text: "fact" };
  const candidateSetHash = "b".repeat(64);
  const valid = validateEvidenceJudgment({ claimId: "C001", candidateSetHash, facets: [{ facetKey: "title", candidates: [{ excerptRef: excerpt.ref, relation: "IRRELEVANT", reason: "The excerpt does not establish the title." }] }] }, claim, new Map([["title", [excerpt]]]), candidateSetHash);
  assert.equal(valid.facets[0]!.candidates[0]!.relation, "IRRELEVANT");
  assert.throws(() => validateEvidenceJudgment({ ...valid, candidateSetHash: "c".repeat(64) }, claim, new Map([["title", [excerpt]]]), candidateSetHash), /candidate-set hash/);
  assert.throws(() => validateEvidenceJudgment({ ...valid, facets: [{ facetKey: "title", candidates: [] }] }, claim, new Map([["title", [excerpt]]]), candidateSetHash), /exactly account/);
  assert.throws(() => validateEvidenceJudgment({ ...valid, facets: [{ facetKey: "title", candidates: [{ excerptRef: `X${"c".repeat(64)}`, relation: "SUPPORTS", reason: "unknown" }] }] }, claim, new Map([["title", [excerpt]]]), candidateSetHash), /unknown excerpt/);
  assert.doesNotThrow(() => evidenceJudgmentSchema.parse(valid));
});

test("claim schema remains strict and bounded to five claims", () => {
  assert.throws(() => claimBatchSchema.parse({ claims: Array.from({ length: 6 }, (_, index) => ({ localKey: `c${index}`, category: "OTHER", statement: "x", materiality: "LOW", facets: [{ key: "x", label: "x", materiality: "LOW", lineIds: ["P1L1"] }] })), exclusions: [], deferredLineIds: [] }), /Too big/);
});

test("stage fingerprints invalidate only the changed stage and its dependents", () => {
  const stored = { claims: "c1", evidence: "e1", summary: "s1", audit: "a1" };
  assert.deepEqual(invalidatedFinalizationStages(stored, { claims: "c1", evidence: "e2" }), ["evidence", "summary", "audit"]);
  assert.deepEqual(invalidatedFinalizationStages(stored, { summary: "s2" }), ["summary", "audit"]);
  assert.deepEqual(invalidatedFinalizationStages(stored, { audit: "a1" }), []);
});

test("V5 rejects adjacent contribution, employment, and community-role evidence", () => {
  assert.equal(v5FacetEvidenceCompatible("Diego Russo authored CPython pull request 12345.", "Diego Russo is a CPython core developer."), false);
  assert.equal(v5FacetEvidenceCompatible("MLIA commit abc123 was authored by Diego Russo.", "Diego Russo was employed by Arm from 2013 to 2017."), false);
  assert.equal(v5FacetEvidenceCompatible("MLIA commit abc123 was authored by Diego Russo.", "Diego Russo held the title Principal Software Engineer at Arm."), false);
  assert.equal(v5FacetEvidenceCompatible("Diego Russo implemented a CPython JIT optimization.", "Diego Russo organized EuroPython 2024."), false);
  assert.equal(v5FacetEvidenceCompatible("Diego Russo implemented a CPython JIT optimization.", "Diego Russo led the Arm Python Guild."), false);
});
