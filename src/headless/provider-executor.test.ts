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

test("forwards normalized includeDomains to the Exa search request only when supplied", async () => {
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

  await executor.executeHeadless({ tool: "web.search", arguments: { query: "Exact Candidate Name", mode: "deep", includeDomains: ["Rowan.Example.EDU", "*.example.edu"] } }, context);
  await executor.executeHeadless({ tool: "web.search", arguments: { query: "Exact Candidate Name without filter" } }, context);

  assert.deepEqual(networkArguments[0]?.includeDomains, ["*.example.edu", "rowan.example.edu"]);
  assert.equal(networkArguments[0]?.type, "deep");
  assert.equal("includeDomains" in networkArguments[1]!, false);
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
