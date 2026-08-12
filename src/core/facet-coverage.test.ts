import assert from "node:assert/strict";
import test from "node:test";

import { assertSelfContainedFacetLabels, auditClaimFacetCoverage } from "./facet-coverage.ts";

test("facet coverage accepts coherent employment clauses with self-contained labels", () => {
  const result = auditClaimFacetCoverage(
    "Staff Software Engineer at Arm DSG, Cambridge UK, 2013–2017; collaborated with GNU team on optimized GNU toolchains for Arm processors.",
    [
      { key: "employer", label: "Employer/team: Arm Ltd, DSG", materiality: "HIGH" },
      { key: "dates", label: "Employment interval: 2013–2017", materiality: "HIGH" },
      { key: "gnu", label: "GNU collaboration: optimized GNU toolchains for Arm processors", materiality: "MEDIUM" },
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
});
