import assert from "node:assert/strict";
import test from "node:test";
import { investigationCases, sampleReport } from "./evidence.ts";

test("example sources have unique identifiers and sample totals remain consistent", () => {
  for (const investigation of investigationCases) {
    const all = investigation.evidence;
    assert.equal(new Set(all.map(source => source.id)).size, all.length);
    for (const relation of ["supports", "contradicts", "unresolved"] as const) {
      const sources = all.filter(source => source.relation === relation);
      assert.ok(sources.length > 0);
      assert.ok(sources.every(source => source.relation === relation));
      assert.ok(sources.every(source => source.quote && source.detail && source.date));
    }
    assert.equal(all.length, investigation.evidence.length);
  }
  assert.equal(sampleReport.outcomes.reduce((sum, outcome) => sum + outcome.count, 0), sampleReport.claims);
  assert.ok(sampleReport.linkedFindings <= sampleReport.claims);
});
