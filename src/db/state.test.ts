import assert from "node:assert/strict";
import test from "node:test";

import { boundedJson } from "./state.ts";

test("research context trims provider history before verification claims", () => {
  const payload = {
    assignedResearchQuestions: [{ id: "question-1" }],
    claims: [{ id: "claim-1", normalizedClaim: "A coherent verification unit." }],
    providerAttempts: Array.from({ length: 240 }, (_, index) => ({ id: index, detail: "provider attempt ".padEnd(1_500, "x") })),
  };
  const result = boundedJson(payload, 128 * 1024, ["providerAttempts", "claims"]);

  assert.equal(result.truncated, true);
  assert.deepEqual(result.truncatedSections, ["providerAttempts"]);
  assert.deepEqual(result.claims, payload.claims);
});
