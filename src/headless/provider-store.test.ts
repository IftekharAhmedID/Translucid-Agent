import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ProviderCallInput } from "../providers/backend.ts";
import { MemoryRunBudget } from "./budget.ts";
import { createFileProviderBackend, summarizeProviderIntervals } from "./provider-store.ts";
import { FileSourceStore } from "./source-store.ts";

function request(run: ProviderCallInput["run"], sessionId: string): ProviderCallInput {
  return {
    context: { runId: "run-provider", agent: "lead-researcher", sessionId },
    capability: "WEB_SEARCH",
    semanticTool: "web.fetch",
    provider: "fixture",
    providerRoute: "fixture.web.fetch",
    networkArguments: { url: "https://example.test/profile" },
    countCeiling: 100,
    providerBudgetUsd: 10,
    run,
  };
}

test("deduplicates in-flight requests, captures immutable sources, and charges the network once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-provider-store-"));
  try {
    const sourceStore = await FileSourceStore.open(directory);
    const budget = new MemoryRunBudget({ modelUsd: 5, providerUsd: 10, externalNetworkCalls: 300, repositoryClones: 3, socialProfiles: 1 });
    const backend = createFileProviderBackend({ sourceStore, budget, deadlineAt: Date.now() + 60_000 });
    let calls = 0;
    const run: ProviderCallInput["run"] = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        data: { title: "Synthetic Candidate", role: "Principal Engineer" },
        sourceUrl: "https://example.test/profile",
        costUsd: 0.25,
        costSource: "REPORTED",
      };
    };

    const [first, second] = await Promise.all([
      backend(request(run, "session-a")),
      backend(request(run, "session-b")),
    ]);

    assert.equal(calls, 1);
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.deepEqual(second.artifactIds, first.artifactIds);
    assert.deepEqual(budget.snapshot(), {
      modelUsd: 0,
      providerUsd: 0.25,
      externalNetworkCalls: 1,
      routeCounts: { "fixture.web.fetch": 1 },
    });
    assert.equal((await sourceStore.list()).length, 1);
    assert.equal((await sourceStore.verify()).valid, true);
    const requests = (await readFile(join(directory, "sources", "requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(requests.map(({ cache }: { cache: string }) => cache).sort(), ["HIT", "MISS"]);
    assert.deepEqual(new Set(requests.map(({ requestFingerprint }: { requestFingerprint: string }) => requestFingerprint)).size, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not cache failures and never writes secrets into request telemetry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-provider-failure-"));
  try {
    const sourceStore = await FileSourceStore.open(directory);
    const budget = new MemoryRunBudget({ modelUsd: 5, providerUsd: 10, externalNetworkCalls: 3, repositoryClones: 3, socialProfiles: 1 });
    const backend = createFileProviderBackend({ sourceStore, budget, deadlineAt: Date.now() + 60_000 });
    let attempts = 0;
    const run: ProviderCallInput["run"] = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("request failed with secret-token-value");
      return { data: { ok: true }, sourceUrl: "https://example.test/recovered", costUsd: 0, costSource: "FREE_PUBLIC" };
    };
    const input = request(run, "session-failure");
    input.networkArguments = { url: "https://example.test/recovered", authorization: "secret-token-value" };

    await assert.rejects(backend(input), /request failed/);
    const recovered = await backend(input);
    assert.equal(recovered.reused, false);
    assert.equal(attempts, 2);
    const telemetry = await readFile(join(directory, "sources", "requests.jsonl"), "utf8");
    assert.doesNotMatch(telemetry, /secret-token-value/);
    assert.match(telemetry, /REDACTED/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not disclose a provider result when durable source capture fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-provider-capture-failure-"));
  try {
    const sourceStore = await FileSourceStore.open(directory);
    const budget = new MemoryRunBudget({ modelUsd: 5, providerUsd: 10, externalNetworkCalls: 3, repositoryClones: 3, socialProfiles: 1 });
    const backend = createFileProviderBackend({ sourceStore, budget, deadlineAt: Date.now() + 60_000 });
    sourceStore.capture = async () => { throw new Error("durable capture failed"); };
    await assert.rejects(backend(request(async () => ({ data: { secret: "must-not-leak" }, sourceUrl: "https://example.test/secret", costUsd: 0, costSource: "FREE_PUBLIC" }), "capture-failure")), /durable capture failed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("summarizes overlapping provider intervals independently of completion order", () => {
  assert.deepEqual(summarizeProviderIntervals([
    { kind: "provider-start", provider: "exa", providerRoute: "exa.search", semanticTool: "web.search", startedMono: 0, batchId: "b", batchIndex: 0 },
    { kind: "provider-start", provider: "exa", providerRoute: "exa.search", semanticTool: "web.search", startedMono: 5, batchId: "b", batchIndex: 1 },
    { kind: "provider-end", provider: "exa", providerRoute: "exa.search", semanticTool: "web.search", startedMono: 5, endedMono: 15, elapsedMs: 10, batchId: "b", batchIndex: 1 },
    { kind: "provider-end", provider: "exa", providerRoute: "exa.search", semanticTool: "web.search", startedMono: 0, endedMono: 20, elapsedMs: 20, batchId: "b", batchIndex: 0 },
  ]), { requestCount: 2, totalElapsedMs: 30, maxConcurrent: 2, unionElapsedMs: 20 });
});
