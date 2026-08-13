import assert from "node:assert/strict";
import test from "node:test";

import { assertSelfContainedFacetLabels, auditClaimFacetCoverage } from "./facet-coverage.ts";

test("facet coverage accepts coherent employment clauses with self-contained labels", () => {
  const result = auditClaimFacetCoverage(
    "Staff Software Engineer at Organization Alpha, Example City, 2013–2017; collaborated with Project Atlas team on optimized toolchains.",
    [
      { key: "employer", label: "Employer: Organization Alpha", materiality: "HIGH" },
      { key: "dates", label: "Employment interval: 2013–2017", materiality: "HIGH" },
      { key: "toolchain", label: "Project Atlas collaboration: optimized toolchains", materiality: "MEDIUM" },
    ],
  );
  assert.equal(result.complete, true);
  assert.deepEqual(result.uncovered, []);
});

test("facet coverage flags a material clause that has no declared facet", () => {
  const result = auditClaimFacetCoverage(
    "Principal Software Engineer at Acme from 2020–2024; led the eight-person platform team; created the release automation system.",
    [
      { key: "employer", label: "Employer and employment interval: Acme, 2020–2024", materiality: "HIGH" },
      { key: "team", label: "Led the eight-person platform team", materiality: "MEDIUM" },
    ],
  );
  assert.equal(result.complete, false);
  assert.equal(result.uncovered.length, 1);
  assert.match(result.uncovered[0]!.clause, /release automation/i);
});

test("facet labels cannot be generic field names", () => {
  assert.throws(
    () => assertSelfContainedFacetLabels("employment", [{ key: "title", label: "role" }]),
    /facet title.*self-contained/i,
  );
  assert.doesNotThrow(() => assertSelfContainedFacetLabels("employment", [{ key: "title", label: "Title: Principal Engineer" }]));
  assert.doesNotThrow(() => assertSelfContainedFacetLabels("language", [{ key: "proficiency", label: "Language: C1" }]));
});
