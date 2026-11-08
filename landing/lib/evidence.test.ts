import assert from "node:assert/strict";
import test from "node:test";
import { investigationCases } from "./evidence.ts";

test("fictional cases keep distinct evidence with support, conflicts, and unresolved gaps", () => {
  assert.equal(new Set(investigationCases.map(investigation => investigation.id)).size, investigationCases.length);
  for (const investigation of investigationCases) {
    const all = investigation.evidence;
    assert.equal(new Set(all.map(source => source.id)).size, all.length);
    assert.ok(all.every(source => source.title && source.type && source.strength && source.quote && source.detail && source.date));
    for (const relation of ["supports", "contradicts", "unresolved"] as const) {
      const sources = all.filter(source => source.relation === relation);
      assert.ok(sources.length > 0);
    }
  }
});
