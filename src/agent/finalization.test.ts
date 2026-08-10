import assert from "node:assert/strict";
import test from "node:test";

import {
  findingBatchOutputSchema,
  mergeFindingBatches,
  partitionClaims,
  summaryOutputSchema,
} from "./finalization.ts";

const finding = (claimId: string) => ({
  claimId,
  verdict: "UNRESOLVED" as const,
  strength: "WEAK" as const,
  explanation: "The frozen evidence does not resolve this claim.",
  supportingEvidenceIds: [],
  contradictingEvidenceIds: [],
  limitations: ["No accepted direct evidence was available."],
});

test("fifteen ordered claims partition into three deterministic batches of five", () => {
  const claims = Array.from({ length: 15 }, (_, index) => ({ id: `claim-${index + 1}` }));
  assert.deepEqual(
    partitionClaims(claims).map((batch) => batch.map(({ id }) => id)),
    [
      ["claim-1", "claim-2", "claim-3", "claim-4", "claim-5"],
      ["claim-6", "claim-7", "claim-8", "claim-9", "claim-10"],
      ["claim-11", "claim-12", "claim-13", "claim-14", "claim-15"],
    ],
  );
});

test("focused finding schema rejects more than five findings", () => {
  assert.throws(() => findingBatchOutputSchema.parse({
    findings: Array.from({ length: 6 }, (_, index) => finding(`claim-${index}`)),
  }));
});

test("validated batches merge to exactly one finding per expected claim", () => {
  const expected = Array.from({ length: 15 }, (_, index) => `claim-${index + 1}`);
  const batches = partitionClaims(expected).map((batch) => batch.map(finding));
  assert.deepEqual(mergeFindingBatches(batches, expected).map(({ claimId }) => claimId), expected);
  assert.throws(() => mergeFindingBatches([...batches, [finding("claim-1")]], expected), /duplicate/i);
  assert.throws(() => mergeFindingBatches(batches.slice(0, 2), expected), /missing/i);
});

test("summary schema is focused and excludes findings", () => {
  const value = {
    summary: {
      professionalIdentity: { status: "AMBIGUOUS", summary: "Identity remains ambiguous.", evidenceIds: [] },
      professionalTimelineSummary: "The saved observations do not resolve a complete chronology.",
      strongestEvidenceIds: [],
      materialInconsistencies: [],
      unresolvedMaterialClaimIds: ["claim-1"],
      investigationLimitations: ["A source route was unavailable."],
    },
  };
  assert.deepEqual(summaryOutputSchema.parse(value), value);
  assert.throws(() => summaryOutputSchema.parse({ ...value, findings: [finding("claim-1")] }));
});
