import assert from "node:assert/strict";
import test from "node:test";

import postgres from "postgres";

import { closeDatabase } from "./client.ts";
import {
  claimRuns,
  createInvestigation,
  heartbeatRun,
  insertAgentEvent,
  listAgentEvents,
  persistRunCapabilitySnapshot,
  requestCancellation,
} from "./investigations.ts";
import { buildCapabilityRegistry } from "../core/capabilities.ts";

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

test("runner claims four cases concurrently and leaves the fifth queued", async () => {
  for (let index = 0; index < 5; index += 1) {
    await createInvestigation({
      submission: `Synthetic candidate ${index}`,
      runtimeKind: "LOCAL",
      dataClassification: "SYNTHETIC",
    });
  }

  const firstBatch = await claimRuns({
    leaseOwner: "runner-a",
    limit: 4,
    leaseMs: 60_000,
    timeoutMs: 1_800_000,
  });
  assert.equal(firstBatch.length, 4);
  assert.equal(new Set(firstBatch.map((run) => run.id)).size, 4);
  assert.ok(firstBatch.every((run) => run.status === "RUNNING"));

  const secondBatch = await claimRuns({
    leaseOwner: "runner-b",
    limit: 4,
    leaseMs: 60_000,
    timeoutMs: 1_800_000,
  });
  assert.equal(secondBatch.length, 1);
});

test("expired leases are reclaimed and heartbeats extend active leases", async () => {
  await createInvestigation({
    submission: "Synthetic lease candidate",
    runtimeKind: "LOCAL",
    dataClassification: "SYNTHETIC",
  });
  const [claimed] = await claimRuns({
    leaseOwner: "runner-a",
    limit: 1,
    leaseMs: 60_000,
    timeoutMs: 1_800_000,
  });
  assert.ok(claimed);

  await sql`UPDATE runs SET lease_expires_at = now() - interval '1 second' WHERE id = ${claimed.id}`;
  const skipped = await claimRuns({
    leaseOwner: "runner-a",
    limit: 1,
    leaseMs: 60_000,
    timeoutMs: 1_800_000,
    excludeRunIds: [claimed.id],
  });
  assert.equal(skipped.length, 0);
  const [reclaimed] = await claimRuns({
    leaseOwner: "runner-b",
    limit: 1,
    leaseMs: 60_000,
    timeoutMs: 1_800_000,
  });

  assert.equal(reclaimed?.id, claimed.id);
  assert.equal(reclaimed?.attemptCount, 2);
  const previousExpiry = reclaimed?.leaseExpiresAt.getTime() ?? 0;
  const heartbeat = await heartbeatRun(reclaimed!.id, "runner-b", 120_000);
  assert.ok(heartbeat.leaseExpiresAt.getTime() > previousExpiry);
});

test("cancellation and agent events remain durable and ordered", async () => {
  const created = await createInvestigation({
    submission: "Synthetic observable candidate",
    runtimeKind: "LOCAL",
    dataClassification: "SYNTHETIC",
  });

  await insertAgentEvent({
    investigationId: created.investigationId,
    runId: created.runId,
    phase: "INTAKE",
    agent: "runner",
    eventType: "PHASE_STARTED",
    status: "RUNNING",
    publicRationale: "Normalizing synthetic input.",
  });
  await insertAgentEvent({
    investigationId: created.investigationId,
    runId: created.runId,
    phase: "INTAKE",
    agent: "runner",
    eventType: "PHASE_COMPLETED",
    status: "COMPLETED",
  });

  const events = await listAgentEvents(created.investigationId, 0);
  assert.deepEqual(events.map((event) => event.id), [1, 2]);

  const cancelled = await requestCancellation(created.investigationId);
  assert.equal(cancelled.status, "CANCELLED");
  assert.ok(cancelled.cancelRequestedAt instanceof Date);
});

test("public-professional intake is persisted without widening the data boundary", async () => {
  const created = await createInvestigation({
    submission: "Public professional source supplied by its author.",
    runtimeKind: "E2B",
    dataClassification: "PUBLIC_PROFESSIONAL",
  });

  const [investigation] = await sql<Array<{ dataClassification: string }>>`
    SELECT data_classification AS "dataClassification"
    FROM investigations WHERE id = ${created.investigationId}
  `;
  assert.equal(investigation?.dataClassification, "PUBLIC_PROFESSIONAL");
});

test("capability state is pending while queued and becomes runner-authoritative after claim", async () => {
  const created = await createInvestigation({
    submission: "Synthetic capability snapshot case",
    runtimeKind: "LOCAL",
    dataClassification: "SYNTHETIC",
  });
  const [queued] = await sql<Array<{ capabilitySnapshot: unknown }>>`
    SELECT capability_snapshot AS "capabilitySnapshot" FROM runs WHERE id = ${created.runId}
  `;
  assert.equal(queued?.capabilitySnapshot, null);

  const [claimed] = await claimRuns({
    leaseOwner: "runner-capabilities",
    limit: 1,
    leaseMs: 60_000,
    timeoutMs: 60 * 60_000,
  });
  assert.ok(claimed);
  const registry = buildCapabilityRegistry({ PROVIDER_MODE: "fixture" });
  await persistRunCapabilitySnapshot(claimed.id, "runner-capabilities", registry);

  await sql`UPDATE runs SET lease_expires_at = now() - interval '1 second' WHERE id = ${claimed.id}`;
  const [reclaimed] = await claimRuns({
    leaseOwner: "runner-capabilities-reclaimed",
    limit: 1,
    leaseMs: 60_000,
    timeoutMs: 60 * 60_000,
  });
  await persistRunCapabilitySnapshot(reclaimed!.id, "runner-capabilities-reclaimed", registry);

  const [running] = await sql<Array<{ capabilitySnapshot: unknown }>>`
    SELECT capability_snapshot AS "capabilitySnapshot" FROM runs WHERE id = ${created.runId}
  `;
  assert.deepEqual(running?.capabilitySnapshot, registry);
});
