import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCriticBatchBundle,
  buildFindingBatchBundle,
  criticJsonExample,
  criticOutputSchema,
  findingBatchOutputSchema,
  mergeCriticBatches,
  mergeFindingBatches,
  partitionClaims,
  summaryOutputSchema,
  validateCriticBatch,
} from "./finalization.ts";

const finding = (claimId: string) => ({
  claimId,
  verdict: "UNRESOLVED" as const,
  strength: "WEAK" as const,
  explanation: "The frozen evidence does not resolve this claim.",
  supportingEvidenceIds: [],
  contradictingEvidenceIds: [],
  facetNotes: [],
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

test("sixty claims partition into three bounded critic packets of twenty", () => {
  const claims = Array.from({ length: 60 }, (_, index) => ({ id: `claim-${index + 1}` }));
  assert.deepEqual(partitionClaims(claims, 20).map(({ length }) => length), [20, 20, 20]);
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

test("finding batches isolate eligible evidence by durable claim link", () => {
  const bundle = buildFindingBatchBundle({
    claims: [
      { id: "claim-1", normalizedClaim: "First claim" },
      { id: "claim-2", normalizedClaim: "Second claim" },
    ],
    evidence: [
      { id: "evidence-1", artifactId: "artifact-1", claimIds: ["claim-1"], relation: "SUPPORTS" },
      { id: "evidence-2", artifactId: "artifact-2", claimIds: ["claim-2"], relation: "SUPPORTS" },
      { id: "evidence-shared", artifactId: "artifact-3", claimIds: ["claim-1", "claim-2"], relation: "CONTEXT" },
    ],
    artifacts: [
      { id: "artifact-1" },
      { id: "artifact-2" },
      { id: "artifact-3" },
    ],
    observations: [],
    researchQuestions: [],
    critic: { claimConcerns: [], limitations: [] },
  }, ["claim-1", "claim-2"]);

  assert.deepEqual(bundle.claimPackets.map(({ claim, facets }) => ({ claimId: claim.id, facets })), [
    { claimId: "claim-1", facets: [] },
    { claimId: "claim-2", facets: [] },
  ]);
  assert.equal("claims" in bundle, false);
  assert.equal("evidence" in bundle, false);
});

test("finding packets expose evidence separately for each declared facet", () => {
  const bundle = buildFindingBatchBundle({
    claims: [{ id: "claim-1", normalizedClaim: "Employment claim", facets: [{ key: "employer", label: "Acme Labs", materiality: "HIGH" }, { key: "title", label: "Principal Engineer", materiality: "HIGH" }] }],
    evidence: [
      { id: "evidence-employer", artifactId: "artifact-1", claimIds: ["claim-1"], relation: "SUPPORTS", facetKeys: ["employer"] },
      { id: "evidence-title", artifactId: "artifact-1", claimIds: ["claim-1"], relation: "SUPPORTS", facetKeys: ["title"] },
      { id: "evidence-context", artifactId: "artifact-1", claimIds: ["claim-1"], relation: "CONTEXT", facetKeys: [] },
    ],
    artifacts: [{ id: "artifact-1" }],
    observations: [],
    researchQuestions: [],
    critic: { claimConcerns: [], limitations: [] },
  }, ["claim-1"]);
  const packet = bundle.claimPackets[0]!;
  assert.deepEqual(packet.facets, [
    { key: "employer", label: "Acme Labs", eligibleEvidenceIds: ["evidence-employer"] },
    { key: "title", label: "Principal Engineer", eligibleEvidenceIds: ["evidence-title"] },
  ]);
  assert.deepEqual(packet.contextEvidence.map(({ id }) => id), ["evidence-context"]);
});

test("summary schema is focused and excludes findings", () => {
  const value = {
    summary: {
      professionalIdentity: { status: "AMBIGUOUS", summary: "Identity remains ambiguous.", evidenceIds: [] },
      professionalTimelineSummary: "The saved observations do not resolve a complete chronology.",
      professionalTimelineEvidenceIds: [],
      professionalIdentityClaimIds: [],
      professionalTimelineClaimIds: [],
      strongestEvidenceIds: [],
      strongestEvidenceByClaim: [],
      materialInconsistencies: [],
      unresolvedMaterialClaimIds: ["claim-1"],
      investigationLimitations: ["A source route was unavailable."],
    },
  };
  assert.deepEqual(summaryOutputSchema.parse(value), value);
  assert.throws(() => summaryOutputSchema.parse({ ...value, findings: [finding("claim-1")] }));
});

test("critic reports only exceptions instead of echoing every accepted evidence ID", () => {
  assert.deepEqual(criticOutputSchema.parse(criticJsonExample), criticJsonExample);
  assert.throws(() => criticOutputSchema.parse({ ...criticJsonExample, acceptedEvidenceIds: [] }));
});

test("critic packets isolate claims, evidence, artifacts and questions in deterministic batches", () => {
  const packet = buildCriticBatchBundle({
    claims: [{ id: "claim-a" }, { id: "claim-b" }],
    entities: [{ id: "person" }],
    identifiers: [],
    links: [],
    artifacts: [{ id: "artifact-a" }, { id: "artifact-b" }],
    observations: [{ id: "observation-a", artifactId: "artifact-a" }, { id: "observation-b", artifactId: "artifact-b" }],
    evidence: [{ id: "evidence-a", artifactId: "artifact-a", claimIds: ["claim-a"] }, { id: "evidence-b", artifactId: "artifact-b", claimIds: ["claim-b"] }],
    researchQuestions: [{ id: "question-a", claimIds: ["claim-a"] }, { id: "question-b", claimIds: ["claim-b"] }],
  }, ["claim-a"]);
  assert.deepEqual(packet.claims.map(({ id }) => id), ["claim-a"]);
  assert.deepEqual(packet.evidence.map(({ id }) => id), ["evidence-a"]);
  assert.deepEqual(packet.artifacts.map(({ id }) => id), ["artifact-a"]);
  assert.deepEqual(packet.observations.map(({ id }) => id), ["observation-a"]);
  assert.deepEqual(packet.researchQuestions.map(({ id }) => id), ["question-a"]);
  assert.deepEqual(packet.entities.map(({ id }) => id), ["person"]);
});

test("critic batches validate scope and merge duplicate global concerns deterministically", () => {
  const evidenceId = "00000000-0000-4000-8000-000000000010";
  const claimId = "00000000-0000-4000-8000-000000000020";
  const first = criticOutputSchema.parse({
    rejectedEvidence: [{ evidenceId, reason: "The quote does not establish the assigned claim." }],
    claimConcerns: [{ claimId, concerns: ["The date is unsupported."] }],
    identityConcerns: ["One identity concern."],
    chronologyConcerns: [],
    limitations: ["One limitation."],
  });
  const second = criticOutputSchema.parse({ ...criticJsonExample, identityConcerns: ["One identity concern."], limitations: ["One limitation."] });
  assert.equal(validateCriticBatch(first, new Set([claimId]), new Set([evidenceId])), first);
  assert.throws(() => validateCriticBatch(first, new Set(), new Set([evidenceId])), /unassigned claim/i);
  assert.throws(() => validateCriticBatch(first, new Set([claimId]), new Set()), /ineligible evidence/i);
  assert.deepEqual(mergeCriticBatches([first, second]), first);
});
