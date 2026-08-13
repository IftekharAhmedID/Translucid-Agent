import assert from "node:assert/strict";
import test from "node:test";

import { auditEvidenceEdges, evidenceQuoteHasClaimAnchor, evaluateEvidenceCompatibility, facetEvidenceCompatible } from "./evidence-fit.ts";

test("evidence quote must share a meaningful claim anchor", () => {
  assert.equal(evidenceQuoteHasClaimAnchor("I work as Principal Software Engineer at Organization Alpha.", "Casey Morgan is a Principal Software Engineer at Organization Alpha."), true);
  assert.equal(evidenceQuoteHasClaimAnchor("The weather forecast is sunny tomorrow.", "Casey Morgan is a Principal Software Engineer at Organization Alpha."), false);
});

test("generic-token-only matches are rejected", () => {
  assert.equal(evidenceQuoteHasClaimAnchor("I am a software engineer on a team.", "A candidate is a software engineer on a team."), false);
});

test("facet compatibility accepts direct work for one facet without requiring the whole compound claim", () => {
  assert.equal(
    facetEvidenceCompatible("Add Casey as Project Atlas code owner", "Maintainer: Project Atlas code ownership"),
    true,
  );
  assert.equal(
    evidenceQuoteHasClaimAnchor(
      "Add Casey as Project Atlas code owner",
      "Casey Morgan served on the triage team and worked at Organization Alpha.",
    ),
    false,
  );
});

test("shifted adjacent evidence pairs are rejected when only a shared generic or single anchor remains", () => {
  assert.equal(evaluateEvidenceCompatibility("The team works here.", "Casey Morgan was Staff Engineer at Organization Alpha from 2013 to 2017.").compatible, false);
  assert.equal(evaluateEvidenceCompatibility("The weather forecast is sunny tomorrow.", "Casey Morgan was Staff Software Engineer at Organization Alpha from 2013 to 2017.").compatible, false);
});

test("the edge audit excludes multi-claim support edges and incompatible quotes", () => {
  const result = auditEvidenceEdges(
    [
      { id: "good", relation: "SUPPORTS", claimIds: ["c1"], facetKeys: ["employer", "title", "tenure"], exactQuote: "Casey Morgan was Staff Engineer at Organization Alpha in Example City from 2013 to 2017." },
      { id: "legacy", relation: "SUPPORTS", claimIds: ["c1", "c2"], exactQuote: "Casey Morgan was Staff Engineer at Organization Alpha." },
      { id: "bad", relation: "SUPPORTS", claimIds: ["c2"], facetKeys: ["project"], exactQuote: "The weather forecast is sunny tomorrow." },
      { id: "context", relation: "CONTEXT", claimIds: ["c1", "c2"], exactQuote: "A general industry context paragraph." },
    ],
    [
      { id: "c1", normalizedClaim: "Casey Morgan was Staff Engineer at Organization Alpha from 2013 to 2017.", facets: [{ key: "employer", label: "Organization Alpha", materiality: "HIGH" }, { key: "title", label: "Staff Engineer", materiality: "HIGH" }, { key: "tenure", label: "2013 to 2017", materiality: "HIGH" }] },
      { id: "c2", normalizedClaim: "Casey Morgan led Project Atlas.", facets: [{ key: "project", label: "Project Atlas", materiality: "HIGH" }] },
    ],
  );
  assert.deepEqual(result.accepted.map(({ id }) => id), ["good", "context"]);
  assert.deepEqual(result.rejected.map(({ evidenceId }) => evidenceId), ["legacy", "bad"]);
});
