import assert from "node:assert/strict";
import test from "node:test";

import { evaluateFactGroups, evaluateQualification, evaluateSemanticReview, loadDiegoFactGroupFixture, normalizeSourceUrl, type FactGroup } from "./qualification-evaluator.ts";

const group: FactGroup = {
  id: "python-governance",
  predicate: "Python governance membership",
  canonicalWitnessFamily: "governance",
  canonicalHostAliases: ["python.org"],
  canonicalPathAliases: ["/dev/"],
  subjectMatchers: ["Diego Russo"],
  predicateMatchers: ["CPython", "core developer"],
  required: true,
};

test("normalizes canonical witness aliases without fragment, default port, or trailing slash", () => {
  assert.equal(normalizeSourceUrl("HTTPS://Python.org:443/dev/team/#history"), "https://python.org/dev/team");
  assert.equal(normalizeSourceUrl("https://python.org/dev/team/"), "https://python.org/dev/team");
});

test("distinguishes missing, discovered, captured, and cited fact-group states", () => {
  const discovery = { ref: "S1", kind: "SEARCH_DISCOVERY", sourceUrl: "https://api.exa.ai/search", title: "CPython lead", highlight: "Diego Russo CPython core developer", provenance: {}, content: "Diego Russo CPython core developer" };
  const canonical = { ref: "S2", kind: "SOURCE_CONTENT", sourceUrl: "https://python.org/dev/team/", title: "Core developers", highlight: "Diego Russo is a CPython core developer", provenance: {}, content: "Diego Russo is a CPython core developer" };
  assert.equal(evaluateFactGroups([group], [], []).at(0)?.status, "MISSING");
  assert.equal(evaluateFactGroups([group], [discovery], []).at(0)?.status, "DISCOVERED");
  assert.equal(evaluateFactGroups([group], [discovery, canonical], []).at(0)?.status, "CAPTURED");
  assert.equal(evaluateFactGroups([group], [discovery, canonical], ["S2"]).at(0)?.status, "CITED");
});

test("captured equivalent canonical witness can qualify without citing the historical benchmark URL", () => {
  const canonical = { ref: "S7", kind: "PROVIDER_RESPONSE", sourceUrl: "https://devguide.python.org/people/", title: "Python developer guide", highlight: "Diego Russo CPython core developer", provenance: { requestedUrl: "https://python.org/dev/" }, content: "Diego Russo CPython core developer" };
  const result = evaluateQualification({ fixture: { schemaVersion: 1, case: "test", groups: [{ ...group, canonicalPathAliases: ["/people/"] }], semanticReviewCases: [] }, sources: [canonical], citedSourceRefs: [], result: { findings: [] } });
  assert.equal(result.factGroups[0]?.status, "CAPTURED");
  assert.equal(result.qualification, "PASS");
});

test("discovery-only material cannot qualify a required fact group", () => {
  const discovery = { ref: "S1", kind: "SEARCH_DISCOVERY", sourceUrl: "https://python.org/dev/", title: "CPython", highlight: "Diego Russo CPython core developer", provenance: {}, content: "Diego Russo CPython core developer" };
  const result = evaluateQualification({ fixture: { schemaVersion: 1, case: "test", groups: [group], semanticReviewCases: [] }, sources: [discovery], citedSourceRefs: ["S1"], result: { findings: [] } });
  assert.equal(result.factGroups[0]?.status, "DISCOVERED");
  assert.equal(result.qualification, "REQUIRES_HUMAN_REVIEW");
  assert.deepEqual(result.requiredUncaptured, ["python-governance"]);
});

test("semantic review never silently passes an absent calibration case", () => {
  const review = evaluateSemanticReview([{ id: "calibration", description: "Check", targetIds: ["missing"], acceptableStatuses: ["UNRESOLVED"] }], { findings: [] });
  assert.equal(review[0]?.status, "REQUIRES_HUMAN_REVIEW");
});

test("the Diego fixture is versioned and includes canonical witness groups", async () => {
  const fixture = await loadDiegoFactGroupFixture();
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.case, "diego");
  assert.ok(fixture.groups.length >= 4);
  assert.ok(fixture.groups.every(({ canonicalWitnessFamily, canonicalHostAliases, subjectMatchers, predicateMatchers }) => canonicalWitnessFamily && canonicalHostAliases.length && subjectMatchers.length && predicateMatchers.length));
});
