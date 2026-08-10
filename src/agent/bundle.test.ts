import assert from "node:assert/strict";
import test from "node:test";

import { buildAdjudicationBundle, selectEvidenceForCritic } from "./bundle.ts";

test("critic evidence selection caps each relation while preferring distinct artifacts", () => {
  const evidence = [
    ...Array.from({ length: 6 }, (_, index) => ({
      id: `support-${index}`,
      artifactId: index < 4 ? "artifact-repeated" : `artifact-${index}`,
      sourceTier: index === 5 ? "Primary - official employer page" : "PRIMARY_SELF_AUTHORED",
      relation: "SUPPORTS",
      claimIds: ["claim-1"],
    })),
    ...Array.from({ length: 3 }, (_, index) => ({ id: `context-${index}`, artifactId: `context-artifact-${index}`, sourceTier: "primary", relation: "CONTEXT", claimIds: ["claim-1"] })),
    ...Array.from({ length: 3 }, (_, index) => ({ id: `contradiction-${index}`, artifactId: `contradiction-artifact-${index}`, sourceTier: "primary", relation: "CONTRADICTS", claimIds: ["claim-1"] })),
  ];

  const selected = selectEvidenceForCritic(evidence);
  assert.equal(selected.filter(({ relation }) => relation === "SUPPORTS").length, 4);
  assert.equal(selected.filter(({ relation }) => relation === "CONTEXT").length, 1);
  assert.equal(selected.filter(({ relation }) => relation === "CONTRADICTS").length, 2);
  assert.equal(selected.some(({ id }) => id === "support-5"), true);
});

test("adjudication bundle contains only accepted evidence and removes review-only duplication", () => {
  const bundle = buildAdjudicationBundle({
    investigationId: "investigation",
    runId: "run",
    claims: [{ id: "claim-1", category: "EMPLOYMENT", normalizedClaim: "Worked at Acme", materiality: "HIGH", sourceSpan: { text: "resume text" }, validFrom: null, validTo: null, status: "OPEN" }],
    entities: [{ id: "person-1", type: "PERSON", canonicalName: "Candidate", metadata: { verbose: true } }],
    identifiers: [{ id: "identifier-1", entityId: "person-1", type: "GITHUB", value: "candidate", normalizedValue: "candidate", confidence: 0.9, evidenceId: "evidence-ok" }],
    links: [],
    artifacts: [
      { id: "artifact-ok", provider: "github", sourceUrl: "https://github.com/candidate", retrievedAt: "2026-01-01", sha256: "abc", httpMetadata: { verbose: true }, provenance: { verbose: true } },
      { id: "artifact-rejected", provider: "web", sourceUrl: "https://example.com", retrievedAt: "2026-01-01", sha256: "def" },
    ],
    observations: [
      { id: "observation-ok", artifactId: "artifact-ok", entityId: "person-1", field: "employer", value: "Acme" },
      { id: "observation-rejected", artifactId: "artifact-rejected", entityId: "person-1", field: "employer", value: "Other" },
    ],
    evidence: [
      { id: "evidence-ok", artifactId: "artifact-ok", exactQuote: "Candidate works at Acme", sourceLocation: {}, sourceTier: "PRIMARY", relation: "SUPPORTS", claimIds: ["claim-1"], entityIds: ["person-1"] },
      { id: "evidence-rejected", artifactId: "artifact-rejected", exactQuote: "Rejected", sourceLocation: {}, sourceTier: "OTHER", relation: "SUPPORTS", claimIds: ["claim-1"], entityIds: [] },
    ],
    researchQuestions: [{ id: "question-1", claimIds: ["claim-1"], question: "Verify", status: "RESOLVED", selectedRoute: "github.rest", resolutionSummary: "Resolved", possibleRoutes: ["github.rest", "web.search"] }],
  }, new Set(["evidence-ok"]), {
    claimConcerns: [],
    identityConcerns: [],
    chronologyConcerns: [],
    limitations: ["Public evidence only"],
  });

  assert.deepEqual(bundle.evidence.map(({ id }) => id), ["evidence-ok"]);
  assert.deepEqual(bundle.artifacts.map(({ id }) => id), ["artifact-ok"]);
  assert.deepEqual(bundle.observations.map(({ id }) => id), ["observation-ok"]);
  assert.equal("httpMetadata" in bundle.artifacts[0]!, false);
  assert.equal("provenance" in bundle.artifacts[0]!, false);
  assert.equal("sourceSpan" in bundle.claims[0]!, false);
  assert.equal("possibleRoutes" in bundle.researchQuestions[0]!, false);
});
