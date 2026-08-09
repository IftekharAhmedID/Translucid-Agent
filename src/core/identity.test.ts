import assert from "node:assert/strict";
import test from "node:test";

import { assessEntityLink } from "./identity.ts";

test("entity links require two independent evidence-backed anchors", () => {
  assert.deepEqual(
    assessEntityLink([
      { type: "EMPLOYER_OVERLAP", evidenceId: "ev-1", sourceKey: "linkedin" },
    ]),
    { allowed: false, confidence: 0, reason: "TWO_INDEPENDENT_ANCHORS_REQUIRED" },
  );

  const result = assessEntityLink([
    { type: "EMPLOYER_OVERLAP", evidenceId: "ev-1", sourceKey: "linkedin" },
    { type: "CROSS_LINKED_ACCOUNT", evidenceId: "ev-2", sourceKey: "personal-site" },
  ]);

  assert.equal(result.allowed, true);
  assert.ok(result.confidence >= 0.7);
});

test("duplicate sources do not count as independent anchors", () => {
  const result = assessEntityLink([
    { type: "EMPLOYER_OVERLAP", evidenceId: "ev-1", sourceKey: "syndicated-bio" },
    { type: "VERIFIED_DOMAIN", evidenceId: "ev-2", sourceKey: "syndicated-bio" },
  ]);

  assert.equal(result.allowed, false);
});
