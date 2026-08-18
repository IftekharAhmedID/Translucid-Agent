import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ProviderCallBackend } from "../providers/backend.ts";
import { ProviderExecutor } from "../providers/executor.ts";
import { MemoryRunBudget } from "./budget.ts";
import { createFileProviderBackend } from "./provider-store.ts";
import { FileSourceStore } from "./source-store.ts";

test("runs provider adapters headlessly without database or research-state arguments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-provider-executor-"));
  try {
    const sourceStore = await FileSourceStore.open(directory);
    const budget = new MemoryRunBudget({ modelUsd: 5, providerUsd: 10, externalNetworkCalls: 300, repositoryClones: 3, socialProfiles: 1 });
    const backend = createFileProviderBackend({ sourceStore, budget, deadlineAt: Date.now() + 60_000 });
    const executor = new ProviderExecutor({ PROVIDER_MODE: "fixture" }, backend);
    const raw = { tool: "web.search", arguments: { query: "Synthetic Candidate Principal Engineer" } };
    const context = { runId: "run-headless", agent: "lead-researcher", sessionId: "session-headless" };

    const first = await executor.executeHeadless(raw, context);
    const second = await executor.executeHeadless(raw, { ...context, sessionId: "session-cache" });

    assert.equal(first.status, "OK");
    assert.equal(first.cache, "MISS");
    assert.equal(second.cache, "HIT");
    assert.deepEqual(second.sourceRefs, first.sourceRefs);
    assert.deepEqual(first.sourceRefs, ["S1"]);
    assert.match(first.preview, /Synthetic Candidate/);
    assert.equal(budget.snapshot().externalNetworkCalls, 1);
    const telemetry = await readFile(join(directory, "sources", "requests.jsonl"), "utf8");
    assert.doesNotMatch(telemetry, /questionId|claimIds|publicRationale/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("forwards normalized Exa material-route controls and a host-owned deep prompt", async () => {
  const networkArguments: Array<Record<string, unknown>> = [];
  const backend: ProviderCallBackend = async (input) => {
    networkArguments.push(input.networkArguments);
    return {
      provider: "exa",
      providerRoute: "exa.search",
      data: { results: [] },
      sourceUrl: "https://api.exa.ai/search",
      costUsd: 0,
      costSource: "FREE_PUBLIC",
      artifactIds: [],
      evidenceEligibleArtifactIds: [],
      reused: false,
    };
  };
  const executor = new ProviderExecutor({ PROVIDER_MODE: "live", EXA_API_KEY: "test-key" }, backend);
  const context = { runId: "run-headless", agent: "lead-researcher", sessionId: "session-headless" };

  await executor.executeHeadless({ tool: "web.search", arguments: {
    query: "Exact Candidate Name",
    mode: "deep",
    additionalQueries: ["Exact Candidate Name Arm"],
    includeDomains: ["Rowan.Example.EDU", "*.example.edu"],
    excludeDomains: ["LinkedIn.COM"],
    startPublishedDate: "2020-01-02T03:04:05Z",
    endPublishedDate: "2021-01-02T03:04:05.123Z",
  } }, context);
  await executor.executeHeadless({ tool: "web.search", arguments: { query: "Exact Candidate Name without filter" } }, context);
  await executor.executeHeadless({ tool: "web.search", arguments: { query: "Exact Candidate Name", highlightQuery: "Principal Engineer" } }, context);

  assert.deepEqual(networkArguments[0]?.includeDomains, ["*.example.edu", "rowan.example.edu"]);
  assert.deepEqual(networkArguments[0]?.additionalQueries, ["Exact Candidate Name Arm"]);
  assert.deepEqual(networkArguments[0]?.excludeDomains, ["linkedin.com"]);
  assert.equal(networkArguments[0]?.startPublishedDate, "2020-01-02T03:04:05.000Z");
  assert.equal(networkArguments[0]?.endPublishedDate, "2021-01-02T03:04:05.123Z");
  assert.match(String(networkArguments[0]?.systemPrompt), /Professional verification research/);
  assert.match(String(networkArguments[0]?.systemPrompt), /evidence-objective/);
  assert.deepEqual(networkArguments[0]?.contents, { highlights: true });
  assert.deepEqual(networkArguments[1]?.contents, { highlights: true });
  assert.deepEqual(networkArguments[2]?.contents, { highlights: { query: "Principal Engineer", maxCharacters: 1_200 } });
  assert.equal(networkArguments[0]?.type, "deep");
  assert.equal("includeDomains" in networkArguments[1]!, false);
  assert.equal("systemPrompt" in networkArguments[1]!, false);
});

test("runs ordinary search batches concurrently and returns every bounded lead with source refs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-search-batch-"));
  const originalFetch = globalThis.fetch;
  const active: number[] = [];
  let maximumActive = 0;
  try {
    const sourceStore = await FileSourceStore.open(directory);
    const budget = new MemoryRunBudget({ modelUsd: 5, providerUsd: 10, externalNetworkCalls: 50, repositoryClones: 3, socialProfiles: 1 });
    const executor = new ProviderExecutor(
      { PROVIDER_MODE: "live", EXA_API_KEY: "test-key", EXA_SEARCH_CONCURRENCY: "6" },
      createFileProviderBackend({ sourceStore, budget, deadlineAt: Date.now() + 60_000 }),
    );
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== "https://api.exa.ai/search") throw new Error(`Unexpected request: ${url}`);
      active.push(1);
      maximumActive = Math.max(maximumActive, active.length);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active.pop();
      const body = JSON.parse(String(init?.body)) as { query: string; contents?: Record<string, unknown> };
      return new Response(JSON.stringify({ results: Array.from({ length: 10 }, (_, index) => ({
        url: index === 0 ? `https://example.test/${"long-".repeat(300)}${body.query}` : `https://example.test/${body.query.replaceAll(" ", "-")}/${index}`,
        title: `Title ${index} ${"x".repeat(400)}`,
        publishedDate: "2024-01-01T00:00:00Z",
        author: "Author",
        highlights: ["Evidence ".repeat(500)],
      })) }), { headers: { "content-type": "application/json" } });
    };
    const result = await executor.executeHeadless({ tool: "web.search.batch", arguments: { searches: [{ query: "Candidate employer", maxAgeHours: 24, livecrawlTimeout: 12_000 }, { query: "Candidate project" }] } }, { runId: "run-batch", agent: "lead-researcher", sessionId: "session-batch" });
    assert.equal(result.status, "OK");
    assert.ok(maximumActive >= 2);
    assert.equal(result.sourceRefs.length, 22);
    assert.equal(result.evidenceEligibleSourceRefs.length, 0);
    assert.ok(Buffer.byteLength(result.preview, "utf8") <= 40 * 1024);
    const preview = JSON.parse(result.preview) as { searches: Array<{ results: Array<Record<string, unknown>> }> };
    assert.equal(preview.searches.length, 2);
    assert.equal(preview.searches[0]?.results.length, 10);
    assert.match(String(preview.searches[0]?.results[0]?.discoveryRef), /^S\d+$/);
    assert.equal(preview.searches[0]?.results[0]?.url, null);
    assert.equal(preview.searches[0]?.results[0]?.urlOversize, true);
    assert.equal((await sourceStore.list()).filter((source) => source.kind === "SEARCH_DISCOVERY").length, 22);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps Exa search leads non-citable until a direct fetch captures the same URL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-search-fetch-transition-"));
  const originalFetch = globalThis.fetch;
  try {
    const sourceStore = await FileSourceStore.open(directory);
    const budget = new MemoryRunBudget({ modelUsd: 5, providerUsd: 10, externalNetworkCalls: 10, repositoryClones: 3, socialProfiles: 1 });
    const executor = new ProviderExecutor(
      { PROVIDER_MODE: "live", EXA_API_KEY: "test-key" },
      createFileProviderBackend({ sourceStore, budget, deadlineAt: Date.now() + 60_000 }),
    );
    globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://api.exa.ai/search") {
        return new Response(JSON.stringify({
          results: [
            { url: "https://example.test/a", title: "A", highlights: ["A lead"] },
            { url: "https://example.test/b", title: "B" },
            { url: "https://example.test/c" },
          ],
          output: { content: "Deep synthesis" },
        }), { headers: { "content-type": "application/json" } });
      }
      if (url === "https://api.exa.ai/contents") {
        return new Response(JSON.stringify({ statuses: [{ id: "https://example.test/b", status: "success" }], results: [{ url: "https://example.test/b", title: "B", text: "Directly fetched source content" }] }), { headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const context = { runId: "run-search-fetch", agent: "lead-researcher", sessionId: "session-search-fetch" };
    const search = await executor.executeHeadless({ tool: "web.search", arguments: { query: "Exact Candidate Name", mode: "deep" } }, context);
    assert.deepEqual(search.sourceRefs, ["S1", "S2", "S3", "S4"]);
    assert.deepEqual(search.evidenceEligibleSourceRefs, []);
    assert.deepEqual((await sourceStore.list()).map((source) => ({ ref: source.ref, kind: source.kind, url: source.sourceUrl })), [
      { ref: "S1", kind: "SEARCH_DISCOVERY", url: "https://api.exa.ai/search" },
      { ref: "S2", kind: "SEARCH_DISCOVERY", url: "https://example.test/a" },
      { ref: "S3", kind: "SEARCH_DISCOVERY", url: "https://example.test/b" },
      { ref: "S4", kind: "SEARCH_DISCOVERY", url: "https://example.test/c" },
    ]);

    const fetched = await executor.executeHeadless({ tool: "web.fetch", arguments: { url: "https://example.test/b" } }, context);
    assert.deepEqual(fetched.sourceRefs, ["S5"]);
    assert.deepEqual(fetched.evidenceEligibleSourceRefs, ["S5"]);
    const inventory = await sourceStore.inventory();
    assert.deepEqual(inventory.sources.filter((source) => source.url === "https://example.test/b").map((source) => ({ ref: source.ref, sourceKind: source.sourceKind, citationEligible: source.citationEligible })), [
      { ref: "S3", sourceKind: "SEARCH_DISCOVERY", citationEligible: false },
      { ref: "S5", sourceKind: "SOURCE_CONTENT", citationEligible: true },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a successful-looking Exa HTTP response when the parent status failed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-exa-failed-status-"));
  const originalFetch = globalThis.fetch;
  try {
    const sourceStore = await FileSourceStore.open(directory);
    const budget = new MemoryRunBudget({ modelUsd: 5, providerUsd: 10, externalNetworkCalls: 10, repositoryClones: 3, socialProfiles: 1 });
    const executor = new ProviderExecutor({ PROVIDER_MODE: "live", EXA_API_KEY: "test-key" }, createFileProviderBackend({ sourceStore, budget, deadlineAt: Date.now() + 60_000 }));
    globalThis.fetch = async () => new Response(JSON.stringify({ statuses: [{ id: "https://example.test/failed", status: "error" }], results: [{ url: "https://example.test/failed", text: "Should not be citable" }] }), { headers: { "content-type": "application/json" } });
    const result = await executor.executeHeadless({ tool: "web.fetch", arguments: { url: "https://example.test/failed" } }, { runId: "run-failed-status", agent: "lead-researcher", sessionId: "session-failed-status" });
    assert.equal(result.status, "OK");
    assert.deepEqual(result.sourceRefs, []);
    assert.deepEqual(result.evidenceEligibleSourceRefs, []);
    assert.equal((await sourceStore.list()).length, 0);
    assert.match(result.preview, /Should not be citable/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("projects a successful Exa parent and bounded direct subpages into separate citable sources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-exa-subpages-"));
  const originalFetch = globalThis.fetch;
  try {
    const sourceStore = await FileSourceStore.open(directory);
    const budget = new MemoryRunBudget({ modelUsd: 5, providerUsd: 10, externalNetworkCalls: 10, repositoryClones: 3, socialProfiles: 1 });
    const executor = new ProviderExecutor({ PROVIDER_MODE: "live", EXA_API_KEY: "test-key" }, createFileProviderBackend({ sourceStore, budget, deadlineAt: Date.now() + 60_000 }));
    const parentUrl = "https://example.test/hub";
    globalThis.fetch = async () => new Response(JSON.stringify({
      requestId: "req-1",
      statuses: [{ id: "parent-1", status: "success" }],
      results: [{
        id: "parent-1",
        url: parentUrl,
        title: "Authoritative hub",
        publishedDate: "2025-01-02",
        author: "Institution",
        text: "Parent evidence",
        highlights: ["Parent highlight"],
        highlightScores: [0.9],
        subpages: [
          { url: "https://example.test/hub/one", title: "One", text: "First subpage evidence" },
          { url: "https://example.test/hub/two", title: "Two", highlights: ["Second subpage evidence"] },
          { url: "https://example.test/hub/one", text: "Duplicate" },
          { url: "not-a-url", text: "Invalid" },
          { url: "https://example.test/hub/empty", text: "" },
        ],
      }],
    }), { headers: { "content-type": "application/json" } });
    const result = await executor.executeHeadless({ tool: "web.fetch", arguments: { url: parentUrl, subpages: 3, subpageTarget: ["release"] } }, { runId: "run-subpages", agent: "lead-researcher", sessionId: "session-subpages" });
    assert.equal(result.status, "OK");
    assert.deepEqual(result.sourceRefs, ["S1", "S2", "S3"]);
    assert.deepEqual(result.evidenceEligibleSourceRefs, ["S1", "S2", "S3"]);
    const sources = await sourceStore.list();
    assert.deepEqual(sources.map((source) => ({ url: source.sourceUrl, method: source.provenance.captureMethod, parent: source.provenance.parentUrl })), [
      { url: parentUrl, method: "EXA_CONTENTS_PARENT", parent: undefined },
      { url: "https://example.test/hub/one", method: "EXA_CONTENTS_SUBPAGE", parent: parentUrl },
      { url: "https://example.test/hub/two", method: "EXA_CONTENTS_SUBPAGE", parent: parentUrl },
    ]);
    const parentBlob = JSON.parse(await readFile(join(directory, sources[0]!.relativePath), "utf8")) as Record<string, unknown>;
    assert.equal(parentBlob.url, parentUrl);
    assert.equal("results" in parentBlob, false);
    assert.equal("statuses" in parentBlob, false);
    assert.equal("subpages" in parentBlob, false);
    assert.equal((await readFile(join(directory, "sources", "requests.jsonl"), "utf8")).includes("req-1"), false);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("a no-Exa subpage request fails closed while ordinary public fetch remains available", async () => {
  const backend: ProviderCallBackend = async () => { throw new Error("backend should not be called"); };
  const executor = new ProviderExecutor({ PROVIDER_MODE: "live" }, backend);
  const result = await executor.executeHeadless({ tool: "web.fetch", arguments: { url: "https://example.test/hub", subpages: 2, subpageTarget: ["release"] } }, { runId: "run-no-exa-subpages", agent: "lead-researcher", sessionId: "session-no-exa-subpages" });
  assert.equal(result.status, "ERROR");
  assert.deepEqual(result.sourceRefs, []);
  assert.deepEqual(result.evidenceEligibleSourceRefs, []);
});

test("qualification mode removes per-tool numeric provider ceilings", async () => {
  let countCeiling: number | undefined;
  const backend: ProviderCallBackend = async (input) => {
    countCeiling = input.countCeiling;
    return {
      provider: "exa",
      providerRoute: "exa.search",
      data: { results: [] },
      sourceUrl: "https://api.exa.ai/search",
      costUsd: 0,
      costSource: "FREE_PUBLIC",
      artifactIds: [],
      evidenceEligibleArtifactIds: [],
      reused: false,
    };
  };
  const executor = new ProviderExecutor({ PROVIDER_MODE: "live", QUALIFICATION_MODE: "unbounded", EXA_API_KEY: "test-key" }, backend);
  const result = await executor.executeHeadless({ tool: "web.search", arguments: { query: "Exact Candidate Name" } }, { runId: "run-headless", agent: "lead-researcher", sessionId: "session-headless" });
  assert.equal(result.status, "OK");
  assert.equal(countCeiling, Number.POSITIVE_INFINITY);
});
