import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

import { closeDatabase } from "../db/client.ts";
import { claimRuns, createInvestigation } from "../db/investigations.ts";
import { createClaim, openResearchQuestion } from "../db/state.ts";
import { ProviderExecutor } from "./executor.ts";
import { parseToolRequest } from "./contracts.ts";
import { providerRequestFingerprint } from "./request-fingerprint.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for integration tests.");
const sql = postgres(databaseUrl, { max: 2 });
const originalFetch = globalThis.fetch;

test.beforeEach(async () => {
  globalThis.fetch = originalFetch;
  await sql.unsafe(`
    TRUNCATE provider_calls, agent_events, findings, research_questions,
      evidence, observations, artifacts, entity_links, entity_identifiers,
      entities, claims, runs, investigations RESTART IDENTITY CASCADE
  `);
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  await closeDatabase();
  await sql.end();
});

async function activeQuestion() {
  const ids = await createInvestigation({
    submission: "Synthetic provider reliability case.",
    runtimeKind: "LOCAL",
    dataClassification: "SYNTHETIC",
  });
  await claimRuns({ leaseOwner: "provider-test", limit: 1, leaseMs: 60_000, timeoutMs: 60 * 60_000 });
  const claim = await createClaim({ ...ids, category: "IDENTITY", normalizedClaim: "Synthetic identity claim.", materiality: "HIGH" });
  const question = await openResearchQuestion({
    ...ids,
    claimIds: [claim.id],
    question: "Can the submitted professional identity be corroborated?",
    priority: "HIGH",
    possibleRoutes: ["professional.profile", "web.search"],
    createdByAgent: "lead-investigator",
  });
  return { ...ids, claimId: claim.id, questionId: question.id };
}

function operational(ids: { investigationId: string; runId: string }) {
  return { ...ids, agent: "professional-investigator", sessionId: "session-test" };
}

test("duplicate concrete provider requests reuse immutable artifacts without consuming count twice", async () => {
  const ids = await activeQuestion();
  const executor = new ProviderExecutor({ PROVIDER_MODE: "fixture", WEB_SEARCH_CEILING: "1000" });
  const request = (rationale: string) => ({
    tool: "web.search",
    arguments: {
      questionId: ids.questionId,
      claimIds: [ids.claimId],
      publicRationale: rationale,
      query: "Synthetic Candidate identity",
    },
  });
  const first = await executor.execute(request("First discovery request for the identity claim."), operational(ids));
  const second = await executor.execute(request("Second agent asks for the same network-effective query."), operational(ids));

  assert.equal(first.status, "OK");
  assert.deepEqual(second.artifactIds, first.artifactIds);
  const [counts] = await sql<Array<{ calls: number; budgetCount: number; cacheHits: number }>>`
    SELECT
      (SELECT count(*)::integer FROM provider_calls WHERE run_id = ${ids.runId} AND result_status = 'OK') AS calls,
      COALESCE((SELECT (budget_counters->>'web.search')::integer FROM runs WHERE id = ${ids.runId}), 0) AS "budgetCount",
      (SELECT count(*)::integer FROM agent_events WHERE run_id = ${ids.runId} AND event_type = 'PROVIDER_CACHE_HIT') AS "cacheHits"
  `;
  assert.deepEqual(counts, { calls: 1, budgetCount: 1, cacheHits: 1 });
  const [reuse] = await sql<Array<{ reusedFromCallId: string | null; resultStatus: string }>>`
    SELECT reused_from_call_id AS "reusedFromCallId", result_status AS "resultStatus"
    FROM provider_calls WHERE run_id = ${ids.runId} AND result_status = 'CACHE_HIT'
  `;
  assert.equal(reuse?.resultStatus, "CACHE_HIT");
  assert.ok(reuse?.reusedFromCallId);
});

test("a stale in-flight request is abandoned and safely retried", async () => {
  const ids = await activeQuestion();
  const raw = {
    tool: "web.search",
    arguments: { questionId: ids.questionId, claimIds: [ids.claimId], publicRationale: "Recovering a provider request whose former owner disappeared.", query: "Synthetic Candidate stale request" },
  };
  const parsed = parseToolRequest(raw);
  const fingerprint = providerRequestFingerprint("fixture.web.search", parsed.arguments);
  await sql`
    INSERT INTO provider_calls (
      id, investigation_id, run_id, capability, provider, semantic_tool, provider_route,
      request_fingerprint, request_metadata, latency_ms, result_status, cost_source,
      attempt_count, cost_usd, artifact_ids, created_at
    ) VALUES (
      ${randomUUID()}, ${ids.investigationId}, ${ids.runId}, 'WEB_SEARCH', 'fixture',
      'web.search', 'fixture.web.search', ${fingerprint}, '{}'::jsonb, 0,
      'IN_FLIGHT', 'UNKNOWN', 1, 0, '{}'::uuid[], now() - interval '30 seconds'
    )
  `;
  const result = await new ProviderExecutor({ PROVIDER_MODE: "fixture" }).execute(raw, operational(ids));
  assert.equal(result.status, "OK");
  const statuses = await sql<Array<{ resultStatus: string }>>`
    SELECT result_status AS "resultStatus" FROM provider_calls
    WHERE run_id = ${ids.runId} AND request_fingerprint = ${fingerprint}
    ORDER BY created_at
  `;
  assert.deepEqual(statuses.map(({ resultStatus }) => resultStatus), ["ABANDONED", "OK"]);
});

test("LinkdAPI material-field success skips Bright Data", async () => {
  const ids = await activeQuestion();
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return Response.json({ success: true, data: { username: "diegor", fullName: "Diego Russo", currentPositions: [{ title: "Engineer" }] } });
  };
  const executor = new ProviderExecutor({
    PROVIDER_MODE: "live",
    LINKDAPI_API_KEY: "test-linkd",
    BRIGHTDATA_API_KEY: "test-bright",
    BRIGHTDATA_LINKEDIN_PROFILE_DATASET_ID: "dataset-profile",
    LINKDAPI_COST_USD_PER_CALL: "0.01",
  });
  const result = await executor.execute({
    tool: "professional.profile",
    arguments: { questionId: ids.questionId, claimIds: [ids.claimId], publicRationale: "Checking the exact submitted LinkedIn identity and current role.", username: "diegor", requiredMaterialField: "CURRENT_POSITION" },
  }, operational(ids));
  assert.equal(result.status, "OK");
  assert.equal(urls.filter((url) => url.includes("linkdapi.com")).length, 1);
  assert.equal(urls.filter((url) => url.includes("brightdata.com")).length, 0);
});

test("a missing LinkdAPI material field causes exactly one Bright Data fallback", async () => {
  const ids = await activeQuestion();
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("linkdapi.com")) return Response.json({ success: true, data: { username: "diegor", fullName: "Diego Russo", educations: [] } });
    return Response.json([{ url: "https://www.linkedin.com/in/diegor", education: [{ school: "Example University" }] }]);
  };
  const executor = new ProviderExecutor({
    PROVIDER_MODE: "live",
    LINKDAPI_API_KEY: "test-linkd",
    BRIGHTDATA_API_KEY: "test-bright",
    BRIGHTDATA_LINKEDIN_PROFILE_DATASET_ID: "dataset-profile",
  });
  const request = {
    tool: "professional.profile",
    arguments: { questionId: ids.questionId, claimIds: [ids.claimId], publicRationale: "Resolving a material education field absent from the primary profile route.", username: "diegor", requiredMaterialField: "EDUCATION" },
  };
  const first = await executor.execute(request, operational(ids));
  const second = await executor.execute(request, operational(ids));
  assert.equal(first.status, "OK");
  assert.deepEqual(second.artifactIds, first.artifactIds);
  assert.equal(urls.filter((url) => url.includes("linkdapi.com")).length, 1);
  assert.equal(urls.filter((url) => url.includes("brightdata.com")).length, 1);
});

test("Exa search stores discovery separately from evidence-eligible source content and reports cost", async () => {
  const ids = await activeQuestion();
  globalThis.fetch = async () => Response.json({
    results: [{ title: "Example source", url: "https://example.com/profile", highlights: ["Captured source passage"], text: "Captured source passage with context." }],
    costDollars: { total: 0.004 },
  });
  const executor = new ProviderExecutor({ PROVIDER_MODE: "live", EXA_API_KEY: "test-exa" });
  const result = await executor.execute({
    tool: "web.search",
    arguments: { questionId: ids.questionId, claimIds: [ids.claimId], publicRationale: "Discovering one independent public source for the identity claim.", query: "Synthetic Candidate", resultLimit: 5 },
  }, operational(ids));
  assert.equal(result.status, "OK");
  assert.equal(result.artifactIds.length, 2);
  assert.equal(result.evidenceEligibleArtifactIds.length, 1);
  assert.equal(result.costUsd, 0.004);
  assert.equal(result.costSource, "REPORTED");
  const artifacts = await sql<Array<{ id: string; kind: string }>>`SELECT id, kind FROM artifacts WHERE id IN ${sql(result.artifactIds)} ORDER BY kind`;
  assert.deepEqual(artifacts.map(({ kind }) => kind), ["SEARCH_DISCOVERY", "SOURCE_CONTENT"]);
  assert.equal(artifacts.find(({ kind }) => kind === "SOURCE_CONTENT")?.id, result.evidenceEligibleArtifactIds[0]);
});

test("search and fetch telemetry remain distinct at both semantic-tool and provider-route levels", async () => {
  const ids = await activeQuestion();
  globalThis.fetch = async (input) => String(input).endsWith("/search")
    ? Response.json({ results: [], costDollars: { total: 0.001 } })
    : Response.json({ results: [{ url: "https://example.com/profile", text: "Captured profile." }], costDollars: { total: 0.002 } });
  const executor = new ProviderExecutor({ PROVIDER_MODE: "live", EXA_API_KEY: "test-exa" });
  await executor.execute({ tool: "web.search", arguments: { questionId: ids.questionId, claimIds: [ids.claimId], publicRationale: "Discovering a directly relevant source before retrieving its full content.", query: "Synthetic Candidate profile" } }, operational(ids));
  await executor.execute({ tool: "web.fetch", arguments: { questionId: ids.questionId, claimIds: [ids.claimId], publicRationale: "Capturing the submitted public source as immutable evidence material.", url: "https://example.com/profile" } }, operational(ids));
  const calls = await sql<Array<{ semanticTool: string; providerRoute: string }>>`
    SELECT semantic_tool AS "semanticTool", provider_route AS "providerRoute"
    FROM provider_calls WHERE run_id = ${ids.runId} AND result_status = 'OK' ORDER BY created_at
  `;
  assert.deepEqual(calls.map(({ semanticTool, providerRoute }) => ({ semanticTool, providerRoute })), [
    { semanticTool: "web.search", providerRoute: "exa.search" },
    { semanticTool: "web.fetch", providerRoute: "exa.contents" },
  ]);
});
