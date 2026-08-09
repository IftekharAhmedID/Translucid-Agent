import assert from "node:assert/strict";
import test from "node:test";

import { validateAdjudication } from "./adjudication.ts";
import type { AdjudicationOutput } from "./contracts.ts";

const baseOutput: AdjudicationOutput = {
  summary: {
    professionalIdentity: {
      status: "PARTIAL",
      summary: "The synthetic identity has two corroborating anchors.",
      evidenceIds: ["ev-1", "ev-2"],
    },
    professionalTimelineSummary: "Acme association is supported for 2023.",
    strongestEvidenceIds: ["ev-1"],
    materialInconsistencies: [],
    unresolvedMaterialClaimIds: ["claim-2"],
    investigationLimitations: ["No contemporaneous title source was available."],
  },
  findings: [
    {
      claimId: "claim-1",
      verdict: "CORROBORATED",
      strength: "STRONG",
      explanation: "Two independent sources support the association.",
      supportingEvidenceIds: ["ev-1", "ev-2"],
      contradictingEvidenceIds: [],
      limitations: [],
    },
  ],
};

test("adjudication accepts evidence-backed non-ranking output", () => {
  const result = validateAdjudication(baseOutput, new Set(["ev-1", "ev-2"]));
  assert.equal(result.summary.professionalIdentity.status, "PARTIAL");
});

test("adjudication rejects unknown evidence IDs", () => {
  assert.throws(
    () => validateAdjudication(baseOutput, new Set(["ev-1"])),
    /unknown evidence id ev-2/i,
  );
});

test("adjudication rejects rankings and hiring recommendations", () => {
  const prohibited = structuredClone(baseOutput);
  prohibited.summary.professionalTimelineSummary = "Candidate score: 92. Hire candidate.";

  assert.throws(
    () => validateAdjudication(prohibited, new Set(["ev-1", "ev-2"])),
    /prohibited decision language/i,
  );
});
