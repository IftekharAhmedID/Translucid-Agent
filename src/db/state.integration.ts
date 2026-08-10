import assert from "node:assert/strict";
import test from "node:test";

import postgres from "postgres";

import { closeDatabase } from "./client.ts";
import { createInvestigation } from "./investigations.ts";
import {
  addEntityIdentifier,
  captureArtifact,
  captureEvidence,
  createClaim,
  linkEntities,
  linkEvidence,
  listTimeline,
  openResearchQuestion,
  recordObservation,
  reconcileResearchFrontier,
  resolveResearchQuestion,
  selectResearchRoute,
  updateResearchQuestion,
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
  await closeDatabase();
  await sql.end();
});

test("entity graph requires independent evidence-backed anchors", async () => {
  const ids = await createInvestigation({
    submission: "Synthetic Ada claims Acme employment.",
    runtimeKind: "LOCAL",
    dataClassification: "SYNTHETIC",
  });
  const claim = await createClaim({
    ...ids,
    category: "EMPLOYMENT",
    normalizedClaim: "Synthetic Ada worked at Acme.",
    materiality: "HIGH",
  });
  const person = await upsertEntity({
    ...ids,
    type: "PERSON",
    canonicalName: "Synthetic Ada",
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
    content: "Synthetic Ada — Acme — Principal Engineer",
  });
  const artifactB = await captureArtifact({
    ...ids,
    kind: "CAPTURED_PAGE",
    provider: "fixture-personal-site",
    sourceUrl: "https://synthetic.example.test/about",
    mimeType: "text/plain",
    content: "My account is synthetic-ada-dev and I work at Acme.",
  });
  const evidenceA = await captureEvidence({
    ...ids,
    artifactId: artifactA.id,
    exactQuote: "Synthetic Ada — Acme — Principal Engineer",
    sourceTier: "PROFESSIONAL_PROFILE",
    relation: "SUPPORTS",
    claimIds: [claim.id],
    entityIds: [person.id],
  });
  const evidenceB = await captureEvidence({
    ...ids,
    artifactId: artifactB.id,
    exactQuote: "My account is synthetic-ada-dev and I work at Acme.",
    sourceTier: "FIRST_PARTY",
    relation: "SUPPORTS",
    claimIds: [claim.id],
    entityIds: [person.id, account.id],
  });
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
          {
            type: "EMPLOYER_OVERLAP",
            evidenceId: evidenceA.id,
            sourceKey: "fixture-linkedin",
          },
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
      {
        type: "EMPLOYER_OVERLAP",
        evidenceId: evidenceA.id,
        sourceKey: "fixture-linkedin",
      },
      {
        type: "CROSS_LINKED_ACCOUNT",
        evidenceId: evidenceB.id,
        sourceKey: "fixture-personal-site",
      },
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

test("search snippets cannot become evidence and temporal observations remain separate", async () => {
  const ids = await createInvestigation({
    submission: "Synthetic chronology claim.",
    runtimeKind: "LOCAL",
    dataClassification: "SYNTHETIC",
  });
  const entity = await upsertEntity({ ...ids, type: "PERSON", canonicalName: "Synthetic Ada" });
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
        sourceTier: "SEARCH",
        relation: "SUPPORTS",
        claimIds: [],
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
    content: "Synthetic Ada — Software Engineer",
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
    question: "What title did Synthetic Ada hold in 2023?",
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
