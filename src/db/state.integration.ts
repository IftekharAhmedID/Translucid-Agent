import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

import { closeDatabase } from "./client.ts";
import { createInvestigation } from "./investigations.ts";
import {
  addEntityIdentifier,
  authorizeResearchTask,
  beginResearchWave,
  captureArtifact,
  captureEvidence,
  createClaim,
  completeResearchTask,
  getArtifactExcerpts,
  getResearchContext,
  lookupArtifacts,
  linkEntities,
  linkEvidence,
  listTimeline,
  openResearchQuestion,
  recordObservation,
  reconcileResearchFrontier,
  resolveResearchQuestion,
  selectResearchRoute,
  updateResearchQuestion,
  updateClaimFacets,
  upsertEntity,
} from "./state.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for integration tests.");
const sql = postgres(databaseUrl, { max: 2 });

test.beforeEach(async () => {
  await sql.unsafe(`
    TRUNCATE provider_calls, agent_events, findings, research_questions,
      evidence, observations, artifacts, entity_links, entity_identifiers,
      entities, claims, runs, investigations RESTART IDENTITY CASCADE
  `);
});

test.after(async () => {
  await sql.unsafe(`
    TRUNCATE provider_calls, agent_events, findings, research_questions,
      evidence, observations, artifacts, entity_links, entity_identifiers,
      entities, claims, runs, investigations RESTART IDENTITY CASCADE
  `);
  await closeDatabase();
  await sql.end();
});

test("candidate-root authorization is atomic and cannot leave ghost entities", async () => {
  const ids = await createInvestigation({ submission: "Synthetic root authorization.", runtimeKind: "LOCAL", dataClassification: "SYNTHETIC" });
  await assert.rejects(() => upsertEntity({ ...ids, type: "PERSON", canonicalName: "Unauthorized Root", role: "CANDIDATE_ROOT", agent: "professional-investigator" }), /only the lead/i);
  const root = await upsertEntity({ ...ids, type: "PERSON", canonicalName: "Authorized Root", role: "CANDIDATE_ROOT", agent: "lead-investigator" });
  await assert.rejects(() => upsertEntity({ ...ids, type: "PERSON", canonicalName: "Conflicting Root", role: "CANDIDATE_ROOT", agent: "lead-investigator" }), /different candidate root/i);
  const [state] = await sql<Array<{ entityCount: number; rootEntityId: string | null }>>`
    SELECT (SELECT count(*)::integer FROM entities WHERE run_id = ${ids.runId}) AS "entityCount",
      root_entity_id AS "rootEntityId" FROM runs WHERE id = ${ids.runId}
  `;
  assert.deepEqual(state, { entityCount: 1, rootEntityId: root.id });
});

test("entity graph requires independent evidence-backed anchors", async () => {
  const ids = await createInvestigation({
    submission: "Synthetic Casey claims Acme employment.",
    runtimeKind: "LOCAL",
    dataClassification: "SYNTHETIC",
  });
  const claim = await createClaim({
    ...ids,
    category: "EMPLOYMENT",
    normalizedClaim: "Synthetic Casey worked at Acme.",
    materiality: "HIGH",
  });
  const person = await upsertEntity({
    ...ids,
    type: "PERSON",
    canonicalName: "Synthetic Casey",
  });
  const account = await upsertEntity({
    ...ids,
    type: "ACCOUNT",
    canonicalName: "synthetic-ada-dev",
  });
  const artifactA = await captureArtifact({
    ...ids,
    kind: "CAPTURED_PAGE",
    provider: "fixture-linkedin",
    sourceUrl: "https://example.test/synthetic-ada",
    mimeType: "text/plain",
    content: "Synthetic Casey — Acme — Principal Engineer",
  });
  const artifactB = await captureArtifact({
    ...ids,
    kind: "CAPTURED_PAGE",
    provider: "fixture-personal-site",
    sourceUrl: "https://synthetic.dev/about",
    mimeType: "text/plain",
    content: "My account is synthetic-ada-dev and I work at Acme.",
  });
  const evidenceA = await captureEvidence({
    ...ids,
    artifactId: artifactA.id,
    exactQuote: "Synthetic Casey — Acme — Principal Engineer",
    relation: "SUPPORTS",
    claimIds: [claim.id],
    facetKeys: ["legacy_claim"],
    entityIds: [person.id],
  });
  const evidenceB = await captureEvidence({
    ...ids,
    artifactId: artifactB.id,
    exactQuote: "My account is synthetic-ada-dev and I work at Acme.",
    relation: "SUPPORTS",
    claimIds: [claim.id],
    facetKeys: ["legacy_claim"],
    entityIds: [person.id, account.id],
  });
  const [derived] = await sql<Array<{ sourceTier: string }>>`SELECT source_tier AS "sourceTier" FROM evidence WHERE id = ${evidenceA.id}`;
  assert.equal(derived?.sourceTier, "CONTEXT");
  const linkedEvidence = await linkEvidence({ ...ids, evidenceId: evidenceA.id, claimIds: [], entityIds: [account.id] });
  assert.ok(linkedEvidence.entityIds.includes(account.id));

  await assert.rejects(
    () =>
      linkEntities({
        ...ids,
        fromEntityId: person.id,
        toEntityId: account.id,
        relationship: "GITHUB_ACCOUNT",
        anchors: [
          { type: "EMPLOYER_OVERLAP", evidenceId: evidenceA.id },
        ],
      }),
    /two independent/i,
  );

  const link = await linkEntities({
    ...ids,
    fromEntityId: person.id,
    toEntityId: account.id,
    relationship: "GITHUB_ACCOUNT",
    anchors: [
      { type: "EMPLOYER_OVERLAP", evidenceId: evidenceA.id },
      { type: "CROSS_LINKED_ACCOUNT", evidenceId: evidenceB.id },
    ],
  });
  assert.ok(link.confidence >= 0.7);

  const identifier = await addEntityIdentifier({
    ...ids,
    entityId: account.id,
    type: "GITHUB_LOGIN",
    value: "Synthetic-Ada-Dev",
    confidence: link.confidence,
    evidenceId: evidenceB.id,
  });
  assert.equal(identifier.normalizedValue, "synthetic-ada-dev");
});

test("same-lineage evidence cannot be promoted into independent identity anchors", async () => {
  const ids = await createInvestigation({ submission: "Synthetic same-lineage profile.", runtimeKind: "LOCAL", dataClassification: "SYNTHETIC" });
  const person = await upsertEntity({ ...ids, type: "PERSON", canonicalName: "Synthetic Casey" });
  const account = await upsertEntity({ ...ids, type: "ACCOUNT", canonicalName: "ada-dev" });
  const first = await captureArtifact({ ...ids, kind: "PROVIDER_RESPONSE", provider: "linkdapi", sourceUrl: "https://www.linkedin.com/in/ada", mimeType: "text/plain", content: "Ada works at Acme.", provenance: { providerRoute: "linkdapi.profile" } });
  const second = await captureArtifact({ ...ids, kind: "PROVIDER_RESPONSE", provider: "brightdata-linkedin-profile", sourceUrl: "https://linkedin.com/in/Ada/#about", mimeType: "text/plain", content: "Ada links to ada-dev.", provenance: { providerRoute: "brightdata.linkedin-profile" } });
  const evidenceA = await captureEvidence({ ...ids, artifactId: first.id, exactQuote: "Ada works at Acme.", relation: "CONTEXT", claimIds: [], facetKeys: [], entityIds: [person.id] });
  const evidenceB = await captureEvidence({ ...ids, artifactId: second.id, exactQuote: "Ada links to ada-dev.", relation: "CONTEXT", claimIds: [], facetKeys: [], entityIds: [account.id] });
  await assert.rejects(() => linkEntities({ ...ids, fromEntityId: person.id, toEntityId: account.id, relationship: "LINKEDIN_ACCOUNT", agent: "professional-investigator", sessionId: "same-lineage", anchors: [{ type: "EMPLOYER_OVERLAP", evidenceId: evidenceA.id }, { type: "CROSS_LINKED_ACCOUNT", evidenceId: evidenceB.id }] }), /two independent/i);
  const [event] = await sql<Array<{ eventType: string }>>`SELECT event_type AS "eventType" FROM agent_events WHERE run_id = ${ids.runId} ORDER BY id DESC LIMIT 1`;
  assert.equal(event?.eventType, "IDENTITY_LINK_REJECTED");
});

test("search snippets cannot become evidence and temporal observations remain separate", async () => {
  const ids = await createInvestigation({
    submission: "Synthetic chronology claim.",
    runtimeKind: "LOCAL",
    dataClassification: "SYNTHETIC",
  });
  const entity = await upsertEntity({ ...ids, type: "PERSON", canonicalName: "Synthetic Casey" });
  const snippet = await captureArtifact({
    ...ids,
    kind: "SEARCH_RESULT",
    provider: "fixture-search",
    sourceUrl: "https://example.test/search",
    mimeType: "application/json",
    content: '{"snippet":"Principal Engineer"}',
    provenance: { isSearchSnippet: true },
  });
  await assert.rejects(
    () =>
      captureEvidence({
        ...ids,
        artifactId: snippet.id,
        exactQuote: "Principal Engineer",
        relation: "SUPPORTS",
        claimIds: [],
        facetKeys: [],
        entityIds: [entity.id],
      }),
    /search snippets are discovery/i,
  );

  const page = await captureArtifact({
    ...ids,
    kind: "CAPTURED_PAGE",
    provider: "fixture-company",
    sourceUrl: "https://acme.example.test/team",
    mimeType: "text/plain",
    content: "Synthetic Casey — Software Engineer",
  });
  await recordObservation({
    ...ids,
    artifactId: page.id,
    entityId: entity.id,
    field: "EMPLOYMENT_TITLE",
    value: { company: "Acme", title: "Software Engineer" },
    validFrom: new Date("2023-01-01T00:00:00Z"),
  });
  await recordObservation({
    ...ids,
    artifactId: page.id,
    entityId: entity.id,
    field: "EMPLOYMENT_TITLE",
    value: { company: "Acme", title: "Principal Engineer" },
    validFrom: new Date("2024-01-01T00:00:00Z"),
  });

  const timeline = await listTimeline(ids.investigationId, ids.runId);
  assert.deepEqual(
    timeline.map((entry) => (entry.value as { title: string }).title),
    ["Software Engineer", "Principal Engineer"],
  );
});

test("research questions persist route selection and resolution", async () => {
  const ids = await createInvestigation({
    submission: "Synthetic title chronology.",
    runtimeKind: "LOCAL",
    dataClassification: "SYNTHETIC",
  });
  const question = await openResearchQuestion({
    ...ids,
    claimIds: [],
    question: "What title did Synthetic Casey hold in 2023?",
    priority: "HIGH",
    possibleRoutes: ["company-site", "archives"],
    createdByAgent: "lead-investigator",
  });
  const updated = await updateResearchQuestion({ ...ids, questionId: question.id, priority: "MEDIUM", possibleRoutes: ["archives"] });
  assert.equal(updated.priority, "MEDIUM");
  assert.deepEqual(updated.possibleRoutes, ["archives"]);
  const resolved = await resolveResearchQuestion({
    investigationId: ids.investigationId,
    runId: ids.runId,
    questionId: question.id,
    selectedRoute: "archives",
    status: "RESOLVED",
    resolutionSummary: "A dated company page resolves the 2023 title.",
  });

  assert.equal(resolved.status, "RESOLVED");
  assert.equal(resolved.selectedRoute, "archives");
  assert.ok(resolved.resolvedAt instanceof Date);
});

test("frontier reconciliation makes every active question terminal before critic review", async () => {
  const ids = await createInvestigation({
    submission: "Synthetic unfinished frontier.",
    runtimeKind: "LOCAL",
    dataClassification: "SYNTHETIC",
  });
  const open = await openResearchQuestion({
    ...ids,
    claimIds: [],
    question: "Open question",
    priority: "HIGH",
    possibleRoutes: ["web"],
    createdByAgent: "lead-investigator",
  });
  const active = await openResearchQuestion({
    ...ids,
    claimIds: [],
    question: "In-progress question",
    priority: "MEDIUM",
    possibleRoutes: ["archives"],
    createdByAgent: "lead-investigator",
  });
  await selectResearchRoute({ ...ids, questionId: active.id, route: "archives" });

  const result = await reconcileResearchFrontier(ids.investigationId, ids.runId);
  assert.equal(result.reconciledCount, 2);
  assert.equal(result.activeCount, 0);

  const rows = await sql<Array<{ id: string; status: string; selectedRoute: string | null; resolutionSummary: string; resolvedAt: Date | null }>>`
    SELECT id, status, selected_route AS "selectedRoute",
      resolution_summary AS "resolutionSummary", resolved_at AS "resolvedAt"
    FROM research_questions WHERE id IN (${open.id}, ${active.id}) ORDER BY question
  `;
  assert.ok(rows.every((row) => row.status === "EXHAUSTED" && row.resolvedAt instanceof Date));
  assert.equal(rows.find((row) => row.id === active.id)?.selectedRoute, "archives");
  assert.ok(rows.every((row) => row.resolutionSummary.includes("Research ended before")));

  const [event] = await sql<Array<{ eventType: string }>>`
    SELECT event_type AS "eventType" FROM agent_events
    WHERE run_id = ${ids.runId} ORDER BY id DESC LIMIT 1
  `;
  assert.equal(event?.eventType, "RESEARCH_FRONTIER_RECONCILED");
});

test("forced finalization closes active questions without falsely claiming artifact review", async () => {
  const ids = await createInvestigation({ submission: "Synthetic forced finalization.", runtimeKind: "LOCAL", dataClassification: "SYNTHETIC" });
  const question = await openResearchQuestion({ ...ids, claimIds: [], question: "Open question with an unreviewed artifact", priority: "HIGH", possibleRoutes: ["web"], createdByAgent: "lead-investigator" });
  const artifact = await captureArtifact({ ...ids, kind: "SOURCE_CONTENT", provider: "exa", sourceUrl: "https://example.test/unreviewed", mimeType: "text/plain", content: "Captured but not locally reviewed." });
  await sql`
    INSERT INTO provider_calls (
      id, investigation_id, run_id, capability, provider, semantic_tool, provider_route,
      request_fingerprint, request_metadata, latency_ms, result_status, cost_source,
      attempt_count, cost_usd, artifact_ids
    ) VALUES (
      ${randomUUID()}, ${ids.investigationId}, ${ids.runId}, 'WEB_SEARCH', 'exa', 'web.search', 'exa.search',
      ${"forced-finalization-fingerprint"}, ${sql.json({ questionId: question.id })}, 10, 'OK', 'REPORTED',
      1, 0, ${[artifact.id]}::uuid[]
    )
  `;

  const result = await reconcileResearchFrontier(ids.investigationId, ids.runId, { forcedFinalization: true });
  assert.equal(result.reconciledCount, 1);
  const [row] = await sql<Array<{ status: string; resolutionSummary: string }>>`
    SELECT status, resolution_summary AS "resolutionSummary" FROM research_questions WHERE id = ${question.id}
  `;
  assert.equal(row?.status, "EXHAUSTED");
  assert.match(row?.resolutionSummary ?? "", /Emergency finalization/);
  const [event] = await sql<Array<{ eventType: string; unreviewedArtifactIds: string[] }>>`
    SELECT event_type AS "eventType", ARRAY(SELECT jsonb_array_elements_text(payload->'unreviewedArtifactIds')) AS "unreviewedArtifactIds"
    FROM agent_events WHERE run_id = ${ids.runId} AND event_type = 'RESEARCH_FRONTIER_FORCED_FINALIZED'
  `;
  assert.equal(event?.eventType, "RESEARCH_FRONTIER_FORCED_FINALIZED");
  assert.deepEqual(event?.unreviewedArtifactIds, [artifact.id]);
});

test("one targeted second research wave is allowed while duplicate assignments and a third wave are rejected", async () => {
  const ids = await createInvestigation({ submission: "Synthetic adaptive research.", runtimeKind: "LOCAL", dataClassification: "SYNTHETIC" });
  const claim = await createClaim({ ...ids, category: "EMPLOYMENT", normalizedClaim: "Synthetic Casey worked at Acme.", materiality: "HIGH" });
  const question = await openResearchQuestion({ ...ids, claimIds: [claim.id], question: "What was Ada's Acme title?", priority: "HIGH", possibleRoutes: ["web.search"], createdByAgent: "lead-investigator" });
  const secondQuestion = await openResearchQuestion({ ...ids, claimIds: [claim.id], question: "What was Ada's Acme tenure?", priority: "HIGH", possibleRoutes: ["web.search"], createdByAgent: "lead-investigator" });
  const initial = await beginResearchWave({ ...ids, kind: "INITIAL", questionIds: [question.id, secondQuestion.id], publicRationale: "Starting one broad route for the active material title and tenure questions.", agent: "lead-investigator" });
  assert.equal(initial.waveNumber, 1);
  await authorizeResearchTask({ ...ids, assignmentId: "00000000-0000-4000-8000-000000000001", role: "professional-investigator", questionIds: [question.id], agent: "lead-investigator" });
  await assert.rejects(() => authorizeResearchTask({ ...ids, assignmentId: "00000000-0000-4000-8000-000000000002", role: "professional-investigator", questionIds: [question.id], agent: "lead-investigator" }), /already assigned/i);
  await authorizeResearchTask({ ...ids, assignmentId: "00000000-0000-4000-8000-000000000002", role: "professional-investigator", questionIds: [secondQuestion.id], agent: "lead-investigator" });
  await assert.rejects(() => authorizeResearchTask({ ...ids, assignmentId: "00000000-0000-4000-8000-000000000003", role: "professional-investigator", questionIds: [secondQuestion.id], agent: "lead-investigator" }), /maximum two/i);
  await completeResearchTask({ ...ids, assignmentId: "00000000-0000-4000-8000-000000000001", role: "professional-investigator", agent: "lead-investigator" });
  await completeResearchTask({ ...ids, assignmentId: "00000000-0000-4000-8000-000000000002", role: "professional-investigator", agent: "lead-investigator" });
  const targeted = await beginResearchWave({ ...ids, kind: "TARGETED", questionIds: [question.id], escalationReason: "CHRONOLOGY_CONFLICT", publicRationale: "A material chronology conflict requires one targeted archive pass.", agent: "lead-investigator" });
  assert.equal(targeted.waveNumber, 2);
  await authorizeResearchTask({ ...ids, assignmentId: "00000000-0000-4000-8000-000000000004", role: "web-records-investigator", questionIds: [question.id], agent: "lead-investigator" });
  await assert.rejects(() => beginResearchWave({ ...ids, kind: "TARGETED", questionIds: [question.id], escalationReason: "MATERIAL_UNCERTAINTY", publicRationale: "Attempting an impermissible third research wave.", agent: "lead-investigator" }), /third research wave/i);
});

test("the initial research wave rejects uncovered material claims", async () => {
  const ids = await createInvestigation({ submission: "Synthetic uncovered material claim.", runtimeKind: "LOCAL", dataClassification: "SYNTHETIC" });
  const covered = await createClaim({ ...ids, category: "EMPLOYMENT", normalizedClaim: "Synthetic Casey worked at Acme.", materiality: "HIGH" });
  await createClaim({ ...ids, category: "EDUCATION", normalizedClaim: "Synthetic Casey studied computer science.", materiality: "HIGH" });
  const question = await openResearchQuestion({ ...ids, claimIds: [covered.id], question: "What was Ada's Acme title?", priority: "HIGH", possibleRoutes: ["web.search"], createdByAgent: "lead-investigator" });
  await assert.rejects(
    () => beginResearchWave({ ...ids, kind: "INITIAL", questionIds: [question.id], publicRationale: "Attempting to begin before material claim coverage is complete.", agent: "lead-investigator" }),
    /every material claim/i,
  );
});

test("claim 61 is rejected and preserves a visible truncation limitation", async () => {
  const ids = await createInvestigation({ submission: "Synthetic high-density intake.", runtimeKind: "LOCAL", dataClassification: "SYNTHETIC" });
  for (let index = 1; index <= 60; index += 1) {
    await createClaim({ ...ids, category: "REPORTABLE", normalizedClaim: `Reportable synthetic fact ${index}.`, materiality: "LOW", agent: "lead-investigator" });
  }
  await assert.rejects(() => createClaim({ ...ids, category: "REPORTABLE", normalizedClaim: "Reportable synthetic fact 61.", materiality: "LOW", agent: "lead-investigator" }), /CLAIM_EXTRACTION_TRUNCATED/);
  const [counts] = await sql<Array<{ claims: number; events: number }>>`
    SELECT (SELECT count(*)::integer FROM claims WHERE run_id = ${ids.runId}) AS claims,
      (SELECT count(*)::integer FROM agent_events WHERE run_id = ${ids.runId} AND event_type = 'CLAIM_EXTRACTION_TRUNCATED') AS events
  `;
  assert.deepEqual(counts, { claims: 60, events: 1 });
});

test("evidence edges are one-claim for findings and artifacts are searchable locally", async () => {
  const ids = await createInvestigation({ submission: "Synthetic artifact retrieval.", runtimeKind: "LOCAL", dataClassification: "SYNTHETIC" });
  const first = await createClaim({ ...ids, category: "EMPLOYMENT", normalizedClaim: "Synthetic Casey worked at Acme.", materiality: "HIGH" });
  const second = await createClaim({ ...ids, category: "PROJECT", normalizedClaim: "Synthetic Casey maintained Atlas.", materiality: "MEDIUM" });
  const artifact = await captureArtifact({
    ...ids,
    kind: "PROVIDER_RESPONSE",
    provider: "fixture-profile",
    sourceUrl: "https://example.test/profile",
    mimeType: "application/json",
    content: JSON.stringify({ experience: [{ title: "Old" }, { title: "Principal Engineer", company: "Acme" }], sharedQuote: "Synthetic Casey maintained Atlas at Acme.", hidden: { package: "atlas-core" } }),
  });
  await assert.rejects(
    () => captureEvidence({ ...ids, artifactId: artifact.id, exactQuote: "Principal Engineer", relation: "SUPPORTS", claimIds: [first.id, second.id], facetKeys: ["legacy_claim"], entityIds: [] }),
    /exactly one claim/i,
  );
  const context = await captureEvidence({ ...ids, artifactId: artifact.id, exactQuote: "Principal Engineer", relation: "CONTEXT", claimIds: [first.id, second.id], facetKeys: [], entityIds: [] });
  await assert.rejects(() => linkEvidence({ ...ids, evidenceId: context.id, claimIds: [first.id], entityIds: [] }), /only associates entities/i);
  const sharedClaims: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    sharedClaims.push((await createClaim({ ...ids, category: "PROJECT", normalizedClaim: "Synthetic Casey maintained Atlas at Acme.", materiality: "MEDIUM" })).id);
  }
  const sharedEvidence = await Promise.all(sharedClaims.map((claimId) => captureEvidence({ ...ids, artifactId: artifact.id, exactQuote: "Synthetic Casey maintained Atlas at Acme.", relation: "SUPPORTS", claimIds: [claimId], facetKeys: ["legacy_claim"], entityIds: [] })));
  assert.equal(new Set(sharedEvidence.map(({ id }) => id)).size, 3);
  const excerpts = await getArtifactExcerpts(ids.investigationId, ids.runId, { artifactId: artifact.id, queries: ["experience", "atlas-core"] });
  assert.ok((excerpts.excerpts as Array<{ path: string }>).some(({ path }) => path === "$.experience[1].title"));
  const question = await openResearchQuestion({ ...ids, claimIds: [first.id], question: "Does the profile corroborate the Acme employment?", priority: "HIGH", possibleRoutes: ["web.search"], createdByAgent: "lead-investigator" });
  const contextResult = await getResearchContext(ids.investigationId, ids.runId, [question.id]);
  assert.equal((contextResult.assignedResearchQuestions as Array<{ id: string }>)[0]?.id, question.id);
  assert.deepEqual((contextResult.claims as Array<{ id: string }>).map(({ id }) => id), [first.id]);
  const contextMemory = (contextResult.evidence as Array<{ id: string; artifactId: string; independenceGroup: string }>).find(({ id }) => id === context.id);
  assert.equal(contextMemory?.artifactId, artifact.id);
  assert.match(contextMemory?.independenceGroup ?? "", /domain:example\.test|LEGACY_ARTIFACT/i);
});

test("facet declarations can be replaced only before the initial research wave", async () => {
  const ids = await createInvestigation({ submission: "Synthetic facet lifecycle.", runtimeKind: "LOCAL", dataClassification: "SYNTHETIC" });
  const claim = await createClaim({
    ...ids,
    category: "EMPLOYMENT",
    normalizedClaim: "Synthetic Casey worked at Acme Labs from 2020 to 2023.",
    materiality: "HIGH",
    facets: [{ key: "employer", label: "Acme Labs", materiality: "HIGH" }],
  });
  const replacement = [
    { key: "employer", label: "Employer: Acme Labs", materiality: "HIGH" as const },
    { key: "tenure", label: "Employment interval: 2020 to 2023", materiality: "HIGH" as const },
  ];
  await assert.rejects(
    () => updateClaimFacets({ ...ids, claimId: claim.id, facets: replacement, agent: "professional-investigator" }),
    /only the lead/i,
  );
  const updated = await updateClaimFacets({ ...ids, claimId: claim.id, facets: replacement, agent: "lead-investigator", sessionId: "facet-session" });
  assert.deepEqual(updated.facets, replacement);
  const [event] = await sql<Array<{ eventType: string; claimId: string }>>`
    SELECT event_type AS "eventType", payload->>'claimId' AS "claimId"
    FROM agent_events WHERE run_id = ${ids.runId} AND event_type = 'CLAIM_FACETS_UPDATED'
  `;
  assert.deepEqual(event, { eventType: "CLAIM_FACETS_UPDATED", claimId: claim.id });

  const question = await openResearchQuestion({
    ...ids,
    claimIds: [claim.id],
    question: "What was Synthetic Casey's Acme Labs employment interval and Principal Engineer title?",
    priority: "HIGH",
    possibleRoutes: ["web.search"],
    createdByAgent: "lead-investigator",
  });
  const secondClaim = await createClaim({
    ...ids,
    category: "EMPLOYMENT",
    normalizedClaim: "Synthetic Casey held a Principal Engineer title at Acme Labs from 2020 to 2023.",
    materiality: "HIGH",
    facets: [
      { key: "employer", label: "Employer: Acme Labs", materiality: "HIGH" },
      { key: "title", label: "Title: Principal Engineer", materiality: "HIGH" },
      { key: "tenure", label: "Employment interval: 2020 to 2023", materiality: "HIGH" },
    ],
  });
  const repaired = await updateResearchQuestion({ ...ids, questionId: question.id, claimIds: [claim.id, secondClaim.id] });
  assert.deepEqual(repaired.claimIds, [claim.id, secondClaim.id]);
  await beginResearchWave({ ...ids, kind: "INITIAL", questionIds: [question.id], publicRationale: "The declared employment facets are ready for research.", agent: "lead-investigator" });
  await assert.rejects(
    () => updateClaimFacets({ ...ids, claimId: claim.id, facets: replacement, agent: "lead-investigator" }),
    /cannot be updated after the initial research wave/i,
  );
  await assert.rejects(
    () => updateResearchQuestion({ ...ids, questionId: question.id, claimIds: [claim.id] }),
    /only be repaired before the initial research wave/i,
  );
});

test("new evidence persists declared facet keys and rejects missing or unknown keys", async () => {
  const ids = await createInvestigation({ submission: "Synthetic evidence facet storage.", runtimeKind: "LOCAL", dataClassification: "SYNTHETIC" });
  const claim = await createClaim({
    ...ids,
    category: "EMPLOYMENT",
    normalizedClaim: "Synthetic Casey worked at Acme Labs.",
    materiality: "HIGH",
    facets: [{ key: "employer", label: "Acme Labs", materiality: "HIGH" }],
  });
  const artifact = await captureArtifact({
    ...ids,
    kind: "CAPTURED_PAGE",
    provider: "fixture-company",
    sourceUrl: "https://acme.example.test/team",
    mimeType: "text/plain",
    content: "Synthetic Casey worked at Acme Labs.",
  });
  const evidence = await captureEvidence({
    ...ids,
    artifactId: artifact.id,
    exactQuote: "Synthetic Casey worked at Acme Labs.",
    relation: "SUPPORTS",
    claimIds: [claim.id],
    facetKeys: ["employer"],
    entityIds: [],
  });
  const [stored] = await sql<Array<{ facetKeys: string[] }>>`SELECT facet_keys AS "facetKeys" FROM evidence WHERE id = ${evidence.id}`;
  assert.deepEqual(stored?.facetKeys, ["employer"]);
  await assert.rejects(
    () => captureEvidence({ ...ids, artifactId: artifact.id, exactQuote: "Synthetic Casey worked at Acme Labs.", relation: "SUPPORTS", claimIds: [claim.id], facetKeys: [], entityIds: [] }),
    /at least one declared claim facet/i,
  );
  await assert.rejects(
    () => captureEvidence({ ...ids, artifactId: artifact.id, exactQuote: "Synthetic Casey worked at Acme Labs.", relation: "SUPPORTS", claimIds: [claim.id], facetKeys: ["title"], entityIds: [] }),
    /not declared/i,
  );
  const context = await captureEvidence({ ...ids, artifactId: artifact.id, exactQuote: "Synthetic Casey worked at Acme Labs.", relation: "CONTEXT", claimIds: [claim.id], facetKeys: [], entityIds: [] });
  const [contextRow] = await sql<Array<{ facetKeys: string[]; claimCount: number }>>`SELECT facet_keys AS "facetKeys", cardinality(claim_ids)::integer AS "claimCount" FROM evidence WHERE id = ${context.id}`;
  assert.deepEqual(contextRow, { facetKeys: [], claimCount: 1 });
});

test("facet-specific evidence does not require anchors from unrelated facets", async () => {
  const ids = await createInvestigation({ submission: "Synthetic compound facet evidence.", runtimeKind: "LOCAL", dataClassification: "SYNTHETIC" });
  const claim = await createClaim({
    ...ids,
    category: "CONTRIBUTION",
    normalizedClaim: "Casey Morgan was a maintainer on Project Atlas, served on the triage team, and worked at Organization Alpha.",
    materiality: "HIGH",
    facets: [
      { key: "core_developer", label: "Maintainer: Project Atlas code ownership", materiality: "HIGH" },
      { key: "triage", label: "Triage team membership", materiality: "MEDIUM" },
    ],
  });
  const artifact = await captureArtifact({
    ...ids,
    kind: "SOURCE_CONTENT",
    provider: "github",
    sourceUrl: "https://github.com/sample-org/project-atlas/pull/123",
    mimeType: "text/plain",
    content: "Add Casey as code owner of Project Atlas",
  });
  const evidence = await captureEvidence({
    ...ids,
    artifactId: artifact.id,
    exactQuote: "Add Casey as code owner of Project Atlas",
    relation: "SUPPORTS",
    claimIds: [claim.id],
    facetKeys: ["core_developer"],
    entityIds: [],
  });
  assert.ok(evidence.id);
  await assert.rejects(
    () => captureEvidence({
      ...ids,
      artifactId: artifact.id,
      exactQuote: "Add Casey as code owner of Project Atlas",
      relation: "SUPPORTS",
      claimIds: [claim.id],
      facetKeys: ["triage"],
      entityIds: [],
    }),
    /incompatible with facet triage/i,
  );
});

test("artifact lookup recovers immutable provider metadata and exhaustion requires review", async () => {
  const ids = await createInvestigation({ submission: "Synthetic artifact recovery.", runtimeKind: "LOCAL", dataClassification: "SYNTHETIC" });
  const claim = await createClaim({ ...ids, category: "IDENTITY", normalizedClaim: "Synthetic Casey has a public profile.", materiality: "HIGH" });
  const question = await openResearchQuestion({ ...ids, claimIds: [claim.id], question: "Does a public profile exist?", priority: "HIGH", possibleRoutes: ["web.search"], createdByAgent: "lead-investigator" });
  const artifact = await captureArtifact({ ...ids, kind: "SOURCE_CONTENT", provider: "exa", sourceUrl: "https://example.test/profile", mimeType: "text/plain", content: "Synthetic Casey public profile." });
  const providerCallId = randomUUID();
  await sql`
    INSERT INTO provider_calls (
      id, investigation_id, run_id, capability, provider, semantic_tool, provider_route,
      request_fingerprint, request_metadata, latency_ms, result_status, cost_source,
      attempt_count, cost_usd, artifact_ids
    ) VALUES (
      ${providerCallId}, ${ids.investigationId}, ${ids.runId}, 'WEB_SEARCH', 'exa', 'web.search', 'exa.search',
      ${"recovery-fingerprint"}, ${sql.json({ questionId: question.id, claimIds: [claim.id] })}, 10, 'OK', 'REPORTED',
      1, 0, ${[artifact.id]}::uuid[]
    )
  `;
  const lookedUp = await lookupArtifacts(ids.investigationId, ids.runId, { questionIds: [question.id] });
  assert.deepEqual([...lookedUp], [{ artifactId: artifact.id, kind: "SOURCE_CONTENT", sourceUrl: "https://example.test/profile", provider: "exa", providerRoute: "exa.search", providerCallId, evidenceIds: [] }]);
  assert.equal("content" in (lookedUp[0] ?? {}), false);
  await assert.rejects(
    () => resolveResearchQuestion({ ...ids, questionId: question.id, selectedRoute: "web.search", status: "EXHAUSTED", resolutionSummary: "The available route produced no usable evidence." }),
    new RegExp(`UNREVIEWED_ARTIFACTS: ${artifact.id}`),
  );
  const resolved = await resolveResearchQuestion({ ...ids, questionId: question.id, selectedRoute: "web.search", status: "EXHAUSTED", resolutionSummary: "The captured profile was inspected locally and did not resolve the claim.", reviewedArtifactIds: [artifact.id] });
  assert.equal(resolved.status, "EXHAUSTED");
  const [reviewEvent] = await sql<Array<{ eventType: string; reviewedArtifactIds: string[] }>>`
    SELECT event_type AS "eventType", ARRAY(SELECT jsonb_array_elements_text(payload->'reviewedArtifactIds')) AS "reviewedArtifactIds"
    FROM agent_events WHERE run_id = ${ids.runId} AND event_type = 'RESEARCH_ARTIFACTS_REVIEWED'
  `;
  assert.equal(reviewEvent?.eventType, "RESEARCH_ARTIFACTS_REVIEWED");
  assert.deepEqual(reviewEvent?.reviewedArtifactIds, [artifact.id]);
});

test("research context reports facet gaps without treating unknown context as corroboration", async () => {
  const ids = await createInvestigation({ submission: "Synthetic facet-gap state.", runtimeKind: "LOCAL", dataClassification: "SYNTHETIC" });
  const claims = await Promise.all([
    createClaim({ ...ids, category: "EMPLOYMENT", normalizedClaim: "Synthetic Casey worked at Acme Labs.", materiality: "HIGH", facets: [{ key: "employer", label: "Acme Labs", materiality: "HIGH" }] }),
    createClaim({ ...ids, category: "EMPLOYMENT", normalizedClaim: "Synthetic Casey held a Principal Engineer title.", materiality: "HIGH", facets: [{ key: "title", label: "Principal Engineer", materiality: "HIGH" }] }),
    createClaim({ ...ids, category: "PROJECT", normalizedClaim: "Synthetic Casey published the Atlas package.", materiality: "HIGH", facets: [{ key: "package", label: "Atlas package", materiality: "HIGH" }] }),
    createClaim({ ...ids, category: "PROJECT", normalizedClaim: "Synthetic Casey led Northstar.", materiality: "HIGH", facets: [{ key: "project", label: "Northstar", materiality: "HIGH" }] }),
  ]);
  const selfArtifact = await captureArtifact({ ...ids, kind: "PROVIDER_RESPONSE", provider: "linkdapi", sourceUrl: "https://www.linkedin.com/in/synthetic-ada", mimeType: "text/plain", content: "Synthetic Casey worked at Acme Labs." , provenance: { providerRoute: "linkdapi.profile" } });
  const institutionalArtifact = await captureArtifact({ ...ids, kind: "PROVIDER_RESPONSE", provider: "packages", sourceUrl: "https://pypi.org/project/atlas", mimeType: "text/plain", content: "Synthetic Casey published the Atlas package.", provenance: { providerRoute: "packages.inspect" } });
  const contradictionArtifact = await captureArtifact({ ...ids, kind: "SOURCE_CONTENT", provider: "fixture-project", sourceUrl: "https://project.example.test/northstar", mimeType: "text/plain", content: "Synthetic Casey did not lead Northstar." });
  await captureEvidence({ ...ids, artifactId: selfArtifact.id, exactQuote: "Synthetic Casey worked at Acme Labs.", relation: "SUPPORTS", claimIds: [claims[0]!.id], facetKeys: ["employer"], entityIds: [] });
  await captureEvidence({ ...ids, artifactId: institutionalArtifact.id, exactQuote: "Synthetic Casey published the Atlas package.", relation: "SUPPORTS", claimIds: [claims[2]!.id], facetKeys: ["package"], entityIds: [] });
  await captureEvidence({ ...ids, artifactId: contradictionArtifact.id, exactQuote: "Synthetic Casey did not lead Northstar.", relation: "CONTRADICTS", claimIds: [claims[3]!.id], facetKeys: ["project"], entityIds: [] });
  const question = await openResearchQuestion({ ...ids, claimIds: claims.map(({ id }) => id), question: "Which facets have durable evidence?", priority: "HIGH", possibleRoutes: ["web.search"], createdByAgent: "lead-investigator" });
  const context = await getResearchContext(ids.investigationId, ids.runId, [question.id]);
  const coverage = context.facetCoverage as Array<{ claimId: string; status: string; supportEvidenceIds: string[]; contradictingEvidenceIds: string[] }>;
  assert.equal(coverage.find((item) => item.claimId === claims[0]!.id)?.status, "SELF_ONLY");
  assert.equal(coverage.find((item) => item.claimId === claims[1]!.id)?.status, "NO_EVIDENCE");
  assert.equal(coverage.find((item) => item.claimId === claims[2]!.id)?.status, "SUPPORTED");
  assert.equal(coverage.find((item) => item.claimId === claims[3]!.id)?.status, "CONFLICT");
});
