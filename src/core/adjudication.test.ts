import assert from "node:assert/strict";
import test from "node:test";

import { repairFacetFindingBatch, validateAdjudication } from "./adjudication.ts";
import type { AdjudicationOutput } from "./contracts.ts";

const baseOutput: AdjudicationOutput = {
  summary: {
    professionalIdentity: {
      status: "PARTIAL",
      summary: "The synthetic identity has two corroborating anchors.",
      evidenceIds: ["ev-1", "ev-2"],
    },
    professionalTimelineSummary: "Acme association is supported for 2023.",
    professionalTimelineEvidenceIds: ["ev-1"],
    professionalIdentityClaimIds: ["claim-1"],
    professionalTimelineClaimIds: ["claim-1"],
    strongestEvidenceIds: ["ev-1"],
    strongestEvidenceByClaim: [{ claimId: "claim-1", facetKeys: ["facet_1"], evidenceIds: ["ev-1"] }],
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
      facetNotes: [{ facetKey: "claim", status: "SUPPORTED", note: "The association is supported.", evidenceIds: ["ev-1", "ev-2"] }],
      limitations: [],
    },
    {
      claimId: "claim-2",
      verdict: "UNRESOLVED",
      strength: "WEAK",
      explanation: "No contemporaneous title source was available.",
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      facetNotes: [{ facetKey: "claim", status: "UNRESOLVED", note: "No evidence was available.", evidenceIds: [] }],
      limitations: ["The available routes were exhausted."],
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

test("adjudication rejects unknown claim IDs in findings and summaries", () => {
  assert.throws(
    () => validateAdjudication(baseOutput, new Set(["ev-1", "ev-2"]), new Set(["claim-2"])),
    /unknown claim id claim-1/i,
  );
});

test("adjudication requires exactly one finding for every durable claim", () => {
  const missing = structuredClone(baseOutput);
  missing.findings.pop();
  assert.throws(
    () => validateAdjudication(missing, new Set(["ev-1", "ev-2"]), new Set(["claim-1", "claim-2"])),
    /exactly one finding/i,
  );
});

test("non-unresolved findings require evidence linked to that claim", () => {
  const unrelated = new Map([
    ["ev-1", new Set(["claim-9"])],
    ["ev-2", new Set(["claim-9"])],
  ]);
  assert.throws(
    () => validateAdjudication(baseOutput, new Set(["ev-1", "ev-2"]), new Set(["claim-1", "claim-2"]), unrelated),
    /not linked to claim claim-1/i,
  );
});

test("facet verdicts deterministically produce partial corroboration", () => {
  const output = structuredClone(baseOutput);
  output.findings[0] = {
    ...output.findings[0]!,
    verdict: "PARTIALLY_CORROBORATED",
    facetNotes: [
      { facetKey: "title", status: "SUPPORTED", note: "Title supported.", evidenceIds: ["ev-1"] },
      { facetKey: "tenure", status: "UNRESOLVED", note: "Dates unresolved.", evidenceIds: [] },
    ],
  };
  const claimFacets = new Map([
    ["claim-1", [
      { key: "title", label: "Staff Software Engineer", materiality: "HIGH" as const },
      { key: "tenure", label: "2013–2017", materiality: "HIGH" as const },
    ]],
    ["claim-2", [{ key: "claim", label: "Claim", materiality: "LOW" as const }]],
  ]);
  const evidenceClaims = new Map([["ev-1", new Set(["claim-1"])], ["ev-2", new Set(["claim-1"])]]);
  assert.doesNotThrow(() => validateAdjudication(output, new Set(["ev-1", "ev-2"]), new Set(["claim-1", "claim-2"]), evidenceClaims, claimFacets));
});

test("materially contradicted facets take precedence over partial support", () => {
  const output = structuredClone(baseOutput);
  output.findings[0] = {
    ...output.findings[0]!,
    verdict: "CONTRADICTED",
    supportingEvidenceIds: ["ev-1"],
    contradictingEvidenceIds: ["ev-2"],
    facetNotes: [
      { facetKey: "title", status: "SUPPORTED", note: "Title supported.", evidenceIds: ["ev-1"] },
      { facetKey: "tenure", status: "CONTRADICTED", note: "Dates conflict.", evidenceIds: ["ev-2"] },
    ],
  };
  const claimFacets = new Map([
    ["claim-1", [
      { key: "title", label: "Title", materiality: "HIGH" as const },
      { key: "tenure", label: "Dates", materiality: "HIGH" as const },
    ]],
    ["claim-2", [{ key: "claim", label: "Claim", materiality: "LOW" as const }]],
  ]);
  const evidenceClaims = new Map([["ev-1", new Set(["claim-1"])], ["ev-2", new Set(["claim-1"])]]);
  assert.doesNotThrow(() => validateAdjudication(output, new Set(["ev-1", "ev-2"]), new Set(["claim-1", "claim-2"]), evidenceClaims, claimFacets));
});

test("facet notes must cover declared facets and use matching evidence relations", () => {
  const output = structuredClone(baseOutput);
  output.findings[0] = {
    ...output.findings[0]!,
    facetNotes: [{ facetKey: "unknown", status: "SUPPORTED", note: "Wrong facet.", evidenceIds: ["ev-1"] }],
  };
  const claimFacets = new Map([
    ["claim-1", [{ key: "title", label: "Title", materiality: "HIGH" as const }]],
    ["claim-2", [{ key: "claim", label: "Claim", materiality: "LOW" as const }]],
  ]);
  assert.throws(
    () => validateAdjudication(output, new Set(["ev-1", "ev-2"]), new Set(["claim-1", "claim-2"]), undefined, claimFacets),
    /unknown facet/i,
  );
});

test("supported facets require evidence and unresolved findings cannot cite edges", () => {
  const claimFacets = new Map([
    ["claim-1", [{ key: "title", label: "Title", materiality: "HIGH" as const }]],
    ["claim-2", [{ key: "claim", label: "Claim", materiality: "LOW" as const }]],
  ]);
  const unsupported = structuredClone(baseOutput);
  unsupported.findings[0] = { ...unsupported.findings[0]!, verdict: "CORROBORATED", supportingEvidenceIds: [], facetNotes: [{ facetKey: "title", status: "SUPPORTED", note: "No citation.", evidenceIds: [] }] };
  assert.throws(() => validateAdjudication(unsupported, new Set(["ev-1", "ev-2"]), new Set(["claim-1", "claim-2"]), undefined, claimFacets), /without matching evidence/i);
  const unresolved = structuredClone(baseOutput);
  unresolved.findings[0] = { ...unresolved.findings[0]!, supportingEvidenceIds: ["ev-1"], facetNotes: [{ facetKey: "title", status: "SUPPORTED", note: "Title supported.", evidenceIds: ["ev-1"] }] };
  unresolved.findings[1] = { ...unresolved.findings[1]!, supportingEvidenceIds: ["ev-1"] };
  assert.throws(() => validateAdjudication(unresolved, new Set(["ev-1", "ev-2"]), new Set(["claim-1", "claim-2"]), undefined, claimFacets), /unresolved but cites/i);
});

test("unresolved facets cannot discard an accepted facet-aligned edge", () => {
  const claimFacets = new Map([
    ["claim-1", [{ key: "title", label: "Title", materiality: "HIGH" as const }]],
    ["claim-2", [{ key: "claim", label: "Claim", materiality: "LOW" as const }]],
  ]);
  const evidenceClaimIds = new Map([
    ["ev-1", new Set(["claim-1"])],
    ["ev-2", new Set(["claim-2"])],
  ]);
  const evidenceRelations = new Map([
    ["ev-1", "SUPPORTS" as const],
    ["ev-2", "CONTEXT" as const],
  ]);
  const evidenceFacetKeys = new Map([
    ["ev-1", new Set(["title"])],
    ["ev-2", new Set<string>()],
  ]);
  const unresolved = structuredClone(baseOutput);
  unresolved.summary.professionalIdentity.evidenceIds = ["ev-1"];
  unresolved.summary.strongestEvidenceByClaim = [{ claimId: "claim-1", facetKeys: ["title"], evidenceIds: ["ev-1"] }];
  unresolved.findings[0] = {
    ...unresolved.findings[0]!,
    verdict: "UNRESOLVED",
    supportingEvidenceIds: [],
    facetNotes: [{ facetKey: "title", status: "UNRESOLVED", note: "The source was self-representational.", evidenceIds: [] }],
  };
  assert.throws(
    () => validateAdjudication(unresolved, new Set(["ev-1", "ev-2"]), new Set(["claim-1", "claim-2"]), evidenceClaimIds, claimFacets, evidenceRelations, undefined, evidenceFacetKeys),
    /eligible evidence/i,
  );
});

test("deterministic facet repair restores omitted accepted evidence before validation", () => {
  const claimFacets = new Map([
    ["claim-1", [{ key: "title", label: "Title", materiality: "HIGH" as const }]],
  ]);
  const repaired = repairFacetFindingBatch({
    findings: [{
      ...baseOutput.findings[0]!,
      claimId: "claim-1",
      verdict: "UNRESOLVED",
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      facetNotes: [{ facetKey: "title", status: "UNRESOLVED", note: "The model omitted the accepted edge.", evidenceIds: [] }],
    }],
  }, new Set(["ev-1"]), new Map([["ev-1", new Set(["claim-1"])] ]), claimFacets, new Map([["ev-1", "SUPPORTS" as const]]), new Map([["ev-1", new Set(["title"])] ]));
  const finding = (repaired as { findings: Array<{ verdict: string; supportingEvidenceIds: string[]; facetNotes: Array<{ status: string; evidenceIds: string[] }> }> }).findings[0]!;
  assert.equal(finding.verdict, "CORROBORATED");
  assert.deepEqual(finding.supportingEvidenceIds, ["ev-1"]);
  assert.deepEqual(finding.facetNotes[0]?.evidenceIds, ["ev-1"]);
});

test("context authority cannot be described as universal self-representation", () => {
  const output = structuredClone(baseOutput);
  output.summary.professionalTimelineSummary = "All captured evidence is self-representational.";
  assert.throws(
    () => validateAdjudication(output, new Set(["ev-1", "ev-2"]), new Set(["claim-1", "claim-2"]), undefined, undefined, undefined, { CONTEXT: 2, SELF_REPRESENTATION: 1 }),
    /overstates source authority/i,
  );
});

test("summary sections cannot cite context evidence or bleed across claim mappings", () => {
  const evidenceClaims = new Map([
    ["ev-1", new Set(["claim-1"])],
    ["ev-2", new Set(["claim-1"])],
  ]);
  const evidenceRelations = new Map([
    ["ev-1", "SUPPORTS" as const],
    ["ev-2", "CONTEXT" as const],
  ]);
  assert.throws(
    () => validateAdjudication(baseOutput, new Set(["ev-1", "ev-2"]), new Set(["claim-1", "claim-2"]), evidenceClaims, undefined, evidenceRelations),
    /context and cannot be cited/i,
  );
});

test("summary strongest evidence must map to the declared facet", () => {
  const output = structuredClone(baseOutput);
  output.summary.strongestEvidenceByClaim = [{ claimId: "claim-1", facetKeys: ["title"], evidenceIds: ["ev-1"] }];
  const evidenceClaims = new Map([["ev-1", new Set(["claim-1"])]]);
  const evidenceRelations = new Map([["ev-1", "SUPPORTS" as const]]);
  const evidenceFacetKeys = new Map([["ev-1", new Set(["tenure"])]]);
  const claimFacets = new Map([
    ["claim-1", [{ key: "title", label: "Title", materiality: "HIGH" as const }, { key: "tenure", label: "Tenure", materiality: "HIGH" as const }]],
    ["claim-2", [{ key: "claim", label: "Claim", materiality: "LOW" as const }]],
  ]);
  assert.throws(
    () => validateAdjudication(output, new Set(["ev-1", "ev-2"]), new Set(["claim-1", "claim-2"]), evidenceClaims, claimFacets, evidenceRelations, undefined, evidenceFacetKeys),
    /not mapped to a declared facet/i,
  );
});
