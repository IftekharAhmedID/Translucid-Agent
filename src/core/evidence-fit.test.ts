import assert from "node:assert/strict";
import test from "node:test";

import { auditEvidenceEdges, evidenceQuoteHasClaimAnchor, evaluateEvidenceCompatibility, facetEvidenceCompatible } from "./evidence-fit.ts";

test("evidence quote must share a meaningful claim anchor", () => {
  assert.equal(evidenceQuoteHasClaimAnchor("I work as Principal Software Engineer at Arm.", "Diego Russo is a Principal Software Engineer at Arm."), true);
  assert.equal(evidenceQuoteHasClaimAnchor("The weather forecast is sunny tomorrow.", "Diego Russo is a Principal Software Engineer at Arm."), false);
});

test("generic-token-only matches are rejected", () => {
  assert.equal(evidenceQuoteHasClaimAnchor("I am a software engineer on a team.", "A candidate is a software engineer on a team."), false);
});

test("facet compatibility does not promote neighboring technical work into status evidence", () => {
  assert.equal(
    facetEvidenceCompatible("Add Diego as code owner of the JIT", "Core developer: CPython JIT code ownership"),
    false,
  );
  assert.equal(
    evidenceQuoteHasClaimAnchor(
      "Add Diego as code owner of the JIT",
      "Diego Russo was a core developer on CPython, served on the triage team, and worked at Arm Ltd.",
    ),
    false,
  );
});

test("negative semantic fixtures reject adjacent contribution, employment, and community-role evidence", () => {
  assert.equal(facetEvidenceCompatible("Diego Russo authored CPython pull request 12345.", "Diego Russo is a CPython core developer."), false);
  assert.equal(facetEvidenceCompatible("MLIA commit abc123 was authored by Diego Russo.", "Diego Russo was employed by Arm from 2013 to 2017."), false);
  assert.equal(facetEvidenceCompatible("MLIA commit abc123 was authored by Diego Russo.", "Diego Russo held the title Principal Software Engineer at Arm."), false);
  assert.equal(facetEvidenceCompatible("Diego Russo implemented a CPython JIT optimization.", "Diego Russo organized EuroPython 2024."), false);
  assert.equal(facetEvidenceCompatible("Diego Russo implemented a CPython JIT optimization.", "Diego Russo led the Arm Python Guild."), false);
});

test("shifted adjacent evidence pairs are rejected when only a shared generic or single anchor remains", () => {
  assert.equal(evaluateEvidenceCompatibility("The Arm team works here.", "Diego Russo was Staff Engineer at Arm Ltd from 2013 to 2017.").compatible, false);
  assert.equal(evaluateEvidenceCompatibility("The weather forecast is sunny tomorrow.", "Diego Russo was Staff Software Engineer at Arm Ltd from 2013 to 2017.").compatible, false);
});

test("the edge audit excludes multi-claim support edges and incompatible quotes", () => {
  const result = auditEvidenceEdges(
    [
      { id: "good", relation: "SUPPORTS", claimIds: ["c1"], facetKeys: ["employer", "title", "tenure"], exactQuote: "Diego Russo was Staff Engineer at Arm Ltd in Cambridge from 2013 to 2017." },
      { id: "legacy", relation: "SUPPORTS", claimIds: ["c1", "c2"], exactQuote: "Diego Russo was Staff Engineer at Arm Ltd." },
      { id: "bad", relation: "SUPPORTS", claimIds: ["c2"], facetKeys: ["project"], exactQuote: "The weather forecast is sunny tomorrow." },
      { id: "context", relation: "CONTEXT", claimIds: ["c1", "c2"], exactQuote: "A general industry context paragraph." },
    ],
    [
      { id: "c1", normalizedClaim: "Diego Russo was Staff Engineer at Arm Ltd from 2013 to 2017.", facets: [{ key: "employer", label: "Arm Ltd", materiality: "HIGH" }, { key: "title", label: "Staff Engineer", materiality: "HIGH" }, { key: "tenure", label: "2013 to 2017", materiality: "HIGH" }] },
      { id: "c2", normalizedClaim: "Diego Russo led the Northstar project.", facets: [{ key: "project", label: "Northstar project", materiality: "HIGH" }] },
    ],
  );
  assert.deepEqual(result.accepted.map(({ id }) => id), ["good", "context"]);
  assert.deepEqual(result.rejected.map(({ evidenceId }) => evidenceId), ["legacy", "bad"]);
});
