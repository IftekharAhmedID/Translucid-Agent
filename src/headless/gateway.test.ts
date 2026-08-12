import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MemoryRunBudget } from "./budget.ts";
import { createHeadlessGateway } from "./gateway.ts";
import { createFileProviderBackend } from "./provider-store.ts";
import { FileSourceStore } from "./source-store.ts";
import { ProviderExecutor } from "../providers/executor.ts";

test("authorizes one run-scoped token and exposes only headless tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-headless-gateway-"));
  try {
    const sourceStore = await FileSourceStore.open(directory);
    const budget = new MemoryRunBudget({ modelUsd: 5, providerUsd: 10, externalNetworkCalls: 300, repositoryClones: 3, socialProfiles: 1 });
    const executor = new ProviderExecutor(
      { PROVIDER_MODE: "fixture" },
      createFileProviderBackend({ sourceStore, budget, deadlineAt: Date.now() + 60_000 }),
    );
    const modelRequests: Array<{ agent: string; estimatedInputTokens: number }> = [];
    const gateway = createHeadlessGateway({
      runId: "run-gateway",
      deadlineAt: Date.now() + 60_000,
      allowedTools: new Set(["web.search", "source.excerpts"]),
      allowedModels: new Set(["deepseek-v4-flash"]),
      executor,
      sourceStore,
      budget,
      providerMode: "fixture",
      onModelRequest: (request) => modelRequests.push(request),
    });
    await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
    const address = gateway.server.address();
    if (!address || typeof address === "string") throw new Error("Gateway did not bind a TCP port.");
    const origin = `http://127.0.0.1:${address.port}`;
    const headers = {
      authorization: `Bearer ${gateway.token}`,
      "content-type": "application/json",
      "x-run-id": "run-gateway",
    };

    const unauthorized = await fetch(`${origin}/internal/tools/execute`, {
      method: "POST",
      headers: { ...headers, authorization: "Bearer wrong" },
      body: JSON.stringify({ tool: "web.search", arguments: { query: "Synthetic Candidate" } }),
    });
    assert.equal(unauthorized.status, 401);

    const provider = await fetch(`${origin}/internal/tools/execute`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tool: "web.search", arguments: { query: "Synthetic Candidate Principal Engineer" }, operational: { agent: "web-records-researcher", sessionId: "session-a" } }),
    });
    assert.equal(provider.status, 200);
    const providerBody = await provider.json() as { sourceRefs: string[] };
    assert.deepEqual(providerBody.sourceRefs, ["S1"]);

    const excerpt = await fetch(`${origin}/internal/tools/execute`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tool: "source.excerpts", arguments: { sourceRef: "S1", queries: ["Principal Engineer"] } }),
    });
    assert.equal(excerpt.status, 200);
    const excerptBody = await excerpt.json() as {
      excerpts: Array<{ text: string }>;
      returnedCharacters: number;
      remainingCharacters: number | null;
      truncated: boolean;
      budgetExhausted: boolean;
    };
    assert.match(excerptBody.excerpts[0]?.text ?? "", /Principal Engineer/);
    assert.ok(excerptBody.returnedCharacters > 0);
    assert.equal(excerptBody.remainingCharacters, null);
    assert.equal(excerptBody.budgetExhausted, false);

    const unregisteredFinalizerExcerpt = await fetch(`${origin}/internal/tools/execute`, {
      method: "POST",
      headers: { ...headers, "x-opencode-agent": "evidence-compiler" },
      body: JSON.stringify({
        tool: "source.excerpts",
        arguments: { sourceRef: "S1", queries: ["Principal Engineer"] },
        operational: { agent: "evidence-compiler", sessionId: "unregistered-finalizer-session" },
      }),
    });
    assert.equal(unregisteredFinalizerExcerpt.status, 403);

    gateway.registerExcerptAllowance("encoder-session", 0);
    const encoderExcerpt = await fetch(`${origin}/internal/tools/execute`, {
      method: "POST",
      headers: { ...headers, "x-opencode-agent": "evidence-compiler" },
      body: JSON.stringify({
        tool: "source.excerpts",
        arguments: { sourceRef: "S1", queries: ["Principal Engineer"] },
        operational: { agent: "evidence-compiler", sessionId: "encoder-session" },
      }),
    });
    assert.equal(encoderExcerpt.status, 200);
    assert.deepEqual(await encoderExcerpt.json(), {
      sourceRef: "S1",
      excerpts: [],
      returnedCharacters: 0,
      remainingCharacters: 0,
      truncated: true,
      budgetExhausted: true,
    });

    const forbidden = await fetch(`${origin}/internal/tools/execute`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tool: "claim.create", arguments: {} }),
    });
    assert.equal(forbidden.status, 403);

    const sourceIndex = await fetch(`${origin}/internal/sources/index`, { headers });
    assert.equal(sourceIndex.status, 404);

    const completion = await fetch(`${origin}/internal/llm/v1/chat/completions`, {
      method: "POST",
      headers: { ...headers, "x-opencode-agent": "evidence-compiler" },
      body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "bounded compiler prompt" }] }),
    });
    assert.equal(completion.status, 200);
    assert.deepEqual(modelRequests, [{ agent: "evidence-compiler", estimatedInputTokens: 14 }]);

    gateway.cancel();
    const cancelled = await fetch(`${origin}/internal/tools/execute`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tool: "web.search", arguments: { query: "Synthetic Candidate" } }),
    });
    assert.equal(cancelled.status, 401);
    await new Promise<void>((resolve, reject) => gateway.server.close((error) => error ? reject(error) : resolve()));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
