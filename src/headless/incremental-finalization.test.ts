import assert from "node:assert/strict";
import test from "node:test";

import { buildLineCatalog } from "./line-catalog.ts";
import { claimBatchSchema, evidenceJudgmentSchema, invalidatedFinalizationStages, v5StageManifestSchema, validateClaimBatchRecords, validateEvidenceJudgment } from "./incremental-finalization.ts";

const catalog = buildLineCatalog({ pages: [{ page: 1, lines: [
  { line: 1, text: "Casey Morgan" },
  { line: 2, text: "Principal Engineer at Example Corp" },
  { line: 3, text: "Python" },
] }] });

test("claim batch validates line ownership and derives host facts", () => {
  const batch = {
    claims: [
      { localKey: "identity", category: "IDENTITY", statement: "The résumé identifies Casey Morgan.", materiality: "HIGH", facets: [{ key: "name", label: "The person is Casey Morgan.", materiality: "HIGH", lineIds: ["P1L1"] }] },
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
  const duplicate = { claims: [{ localKey: "a", category: "OTHER", statement: "Casey Morgan is identified.", materiality: "LOW", facets: [{ key: "a", label: "The person is Casey Morgan.", materiality: "LOW", lineIds: ["P1L1"] }] }], exclusions: [{ lineIds: ["P1L1"], reason: "NON_ASSERTIVE" }], deferredLineIds: [] };
  assert.match(validateClaimBatchRecords(duplicate, catalog, ["P1L1"]).defects.join("\n"), /more than one disposition/);
});

test("claim records preserve valid disjoint siblings when one candidate is malformed", () => {
  const result = validateClaimBatchRecords({ claims: [
    { localKey: "identity", category: "IDENTITY", statement: "The résumé identifies Casey Morgan.", materiality: "HIGH", facets: [{ key: "name", label: "The person is Casey Morgan.", materiality: "HIGH", lineIds: ["P1L1"] }] },
    { localKey: "broken", category: "EMPLOYMENT", statement: "Broken", materiality: "URGENT", facets: [{ key: "title", label: "Ada held the Principal Engineer title.", materiality: "HIGH", lineIds: ["P1L2"] }] },
  ], exclusions: [{ lineIds: ["P1L3"], reason: "BARE_SKILL" }], deferredLineIds: [] }, catalog, ["P1L1", "P1L2", "P1L3"]);
  assert.deepEqual(result.claims.map(({ claimKey }) => claimKey), ["C001"]);
  assert.deepEqual(result.unresolvedLineIds, ["P1L2"]);
  assert.match(result.defects.join("\n"), /broken/i);
});

test("factual lines cannot be hidden in exclusions", () => {
  const subjective = validateClaimBatchRecords({ claims: [], exclusions: [{ lineIds: ["P1L2"], reason: "SUBJECTIVE_DESCRIPTION" }], deferredLineIds: [] }, catalog, ["P1L2"]);
  assert.deepEqual(subjective.exclusions, []);
  assert.deepEqual(subjective.unresolvedLineIds, ["P1L2"]);
  assert.match(subjective.defects.join("\n"), /factual assertion/i);

  const duplicate = validateClaimBatchRecords({ claims: [], exclusions: [{ lineIds: ["P1L1"], reason: "DUPLICATE" }], deferredLineIds: [] }, catalog, ["P1L1"]);
  assert.deepEqual(duplicate.exclusions, []);
  assert.match(duplicate.defects.join("\n"), /not duplicated/i);

  const falseContact = validateClaimBatchRecords({ claims: [], exclusions: [{ lineIds: ["P1L1"], reason: "CONTACT_DETAIL" }], deferredLineIds: [] }, catalog, ["P1L1"]);
  assert.deepEqual(falseContact.exclusions, []);
  assert.match(falseContact.defects.join("\n"), /contact detail/i);

  const falseHeading = validateClaimBatchRecords({ claims: [], exclusions: [{ lineIds: ["P1L2"], reason: "SECTION_HEADING" }], deferredLineIds: [] }, catalog, ["P1L2"]);
  assert.deepEqual(falseHeading.exclusions, []);
  assert.match(falseHeading.defects.join("\n"), /section heading/i);
});

test("claim keys follow semantic line order rather than model response order", () => {
  const reversed = validateClaimBatchRecords({ claims: [
    { localKey: "employment", category: "EMPLOYMENT", statement: "Ada held a principal engineering role at Example Corp.", materiality: "HIGH", facets: [{ key: "title", label: "Ada held the title Principal Engineer at Example Corp.", materiality: "HIGH", lineIds: ["P1L2"] }] },
    { localKey: "identity", category: "IDENTITY", statement: "The résumé identifies Casey Morgan.", materiality: "HIGH", facets: [{ key: "name", label: "The person is Casey Morgan.", materiality: "HIGH", lineIds: ["P1L1"] }] },
  ], exclusions: [{ lineIds: ["P1L3"], reason: "BARE_SKILL" }], deferredLineIds: [] }, catalog, ["P1L1", "P1L2", "P1L3"]);

  assert.deepEqual(reversed.claims.map(({ claimKey, localKey }) => ({ claimKey, localKey })), [
    { claimKey: "C001", localKey: "identity" },
    { claimKey: "C002", localKey: "employment" },
  ]);
});

test("frozen facet line ownership is canonicalized", () => {
  const result = validateClaimBatchRecords({ claims: [{
    localKey: "identity",
    category: "IDENTITY",
    statement: "The résumé identifies Casey Morgan.",
    materiality: "HIGH",
    facets: [{ key: "name", label: "The person is Casey Morgan.", materiality: "HIGH", lineIds: ["P1L2", "P1L1"] }],
  }], exclusions: [], deferredLineIds: [] }, catalog, ["P1L1", "P1L2"]);
  assert.deepEqual(result.claims[0]?.facets[0]?.lineIds, ["P1L1", "P1L2"]);
});

test("claim records reject non-atomic facets before freezing siblings", () => {
  const result = validateClaimBatchRecords({ claims: [{
    localKey: "compound",
    category: "EMPLOYMENT",
    statement: "Ada worked at Example Corp and led twelve engineers.",
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
  assert.throws(() => validateEvidenceJudgment({ ...valid, facets: [{ facetKey: "title", candidates: [] }] }, claim, new Map([["title", [excerpt]]]), candidateSetHash), new RegExp(`missing ${excerpt.ref}`, "u"));
  assert.throws(() => validateEvidenceJudgment({ ...valid, facets: [{ facetKey: "title", candidates: [{ excerptRef: `X${"c".repeat(64)}`, relation: "SUPPORTS", reason: "unknown" }] }] }, claim, new Map([["title", [excerpt]]]), candidateSetHash), new RegExp(`Expected exact excerpt refs: ${excerpt.ref}`, "u"));
  assert.doesNotThrow(() => evidenceJudgmentSchema.parse(valid));
});

test("evidence judgments are canonicalized to frozen facet and candidate order", () => {
  const first = { ref: `X${"1".repeat(64)}`, sourceRef: "S1", path: "$", offsetStart: 0, offsetEnd: 4, text: "first" };
  const second = { ref: `X${"2".repeat(64)}`, sourceRef: "S2", path: "$", offsetStart: 5, offsetEnd: 10, text: "second" };
  const third = { ref: `X${"3".repeat(64)}`, sourceRef: "S3", path: "$", offsetStart: 0, offsetEnd: 5, text: "third" };
  const candidateSetHash = "b".repeat(64);
  const judgment = validateEvidenceJudgment({
    claimId: "C001",
    candidateSetHash,
    facets: [
      { facetKey: "employer", candidates: [{ excerptRef: third.ref, relation: "SUPPORTS", reason: "Employer match." }] },
      { facetKey: "title", candidates: [
        { excerptRef: second.ref, relation: "IRRELEVANT", reason: "Adjacent fact." },
        { excerptRef: first.ref, relation: "SUPPORTS", reason: "Exact title." },
      ] },
    ],
  }, { claimKey: "C001", facets: [{ key: "title" }, { key: "employer" }] }, new Map([
    ["title", [first, second]],
    ["employer", [third]],
  ]), candidateSetHash);

  assert.deepEqual(judgment.facets.map(({ facetKey, candidates }) => ({ facetKey, refs: candidates.map(({ excerptRef }) => excerptRef) })), [
    { facetKey: "title", refs: [first.ref, second.ref] },
    { facetKey: "employer", refs: [third.ref] },
  ]);
});

test("evidence judgment validation rejects an obvious lexical mismatch before materialization", () => {
  const excerpt = { ref: `X${"4".repeat(64)}`, sourceRef: "S1", path: "$", offsetStart: 0, offsetEnd: 20, text: "A weather station recorded rainfall." };
  assert.throws(() => validateEvidenceJudgment({
    claimId: "C001",
    candidateSetHash: "b".repeat(64),
    facets: [{ facetKey: "status", candidates: [{ excerptRef: excerpt.ref, relation: "SUPPORTS", reason: "Same project." }] }],
  }, { claimKey: "C001", facets: [{ key: "status", label: "Casey Morgan held a principal engineering title." }] }, new Map([["status", [excerpt]]]), "b".repeat(64)), /semantically incompatible/i);
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

test("V5 manifest accepts only stage-local checkpoint paths", () => {
  const valid = { schemaVersion: 3, implementation: "incremental-finalizer-v5", stages: {}, files: { "claims/C001.json": "a".repeat(64), "evidence/C001.judgment.json": "b".repeat(64), "source-authority-snapshot.json": "c".repeat(64), "audit.json": "d".repeat(64) } };
  assert.doesNotThrow(() => v5StageManifestSchema.parse(valid));
  assert.throws(() => v5StageManifestSchema.parse({ ...valid, files: { "evidence/../../../outside.json": "a".repeat(64) } }), /Invalid key|Invalid string/i);
});

test("uppercase factual lines cannot be excluded as headings", () => {
  const factualCatalog = {
    ...catalog,
    lines: [{ ...catalog.lines[0]!, text: "PRINCIPAL ENGINEER AT EXAMPLE SYSTEMS" }],
  };
  const result = validateClaimBatchRecords({ claims: [], exclusions: [{ lineIds: ["P1L1"], reason: "SECTION_HEADING" }], deferredLineIds: [] }, factualCatalog, ["P1L1"]);
  assert.deepEqual(result.exclusions, []);
  assert.match(result.defects.join("\n"), /section heading/i);
});

test("short dotted-leader headings are excluded without admitting factual dotted lines", () => {
  const dottedCatalog = buildLineCatalog({ pages: [{ page: 1, lines: [
    { line: 1, text: "Additional Experience. . . . . . . . . ." },
    { line: 2, text: "Worked at Organization Alpha. . . . . ." },
  ] }] });
  const heading = validateClaimBatchRecords({ claims: [], exclusions: [{ lineIds: ["P1L1"], reason: "SECTION_HEADING" }], deferredLineIds: [] }, dottedCatalog, ["P1L1"]);
  assert.deepEqual(heading.defects, []);
  const factual = validateClaimBatchRecords({ claims: [], exclusions: [{ lineIds: ["P1L2"], reason: "SECTION_HEADING" }], deferredLineIds: [] }, dottedCatalog, ["P1L2"]);
  assert.match(factual.defects.join("\n"), /not a recognized section heading/i);
});

test("generic language section headings remain distinct from factual language assertions", () => {
  const languageCatalog = buildLineCatalog({ pages: [{ page: 1, lines: [
    { line: 1, text: "Languages" },
    { line: 2, text: "Languages include Example Language at professional proficiency." },
  ] }] });
  const heading = validateClaimBatchRecords({ claims: [], exclusions: [{ lineIds: ["P1L1"], reason: "SECTION_HEADING" }], deferredLineIds: [] }, languageCatalog, ["P1L1"]);
  assert.deepEqual(heading.defects, []);
  const factual = validateClaimBatchRecords({ claims: [], exclusions: [{ lineIds: ["P1L2"], reason: "SECTION_HEADING" }], deferredLineIds: [] }, languageCatalog, ["P1L2"]);
  assert.match(factual.defects.join("\n"), /not a recognized section heading/i);
});
