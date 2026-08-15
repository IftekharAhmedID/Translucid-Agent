import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MemoryRunBudget } from "./budget.ts";
import { createHeadlessGateway } from "./gateway.ts";
import { ReportStore } from "./report-store.ts";
import { createFileProviderBackend } from "./provider-store.ts";
import { FileSourceStore } from "./source-store.ts";
import { ProviderExecutor } from "../providers/executor.ts";

test("persists specialist memos through the host gateway only during research", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-memo-gateway-"));
  try {
    const sourceStore = await FileSourceStore.open(directory);
    const budget = new MemoryRunBudget({ modelUsd: 5, providerUsd: 10, externalNetworkCalls: 300, repositoryClones: 3, socialProfiles: 1 });
    const persisted: unknown[] = [];
    const gateway = createHeadlessGateway({
      runId: "run-memo",
      deadlineAt: Date.now() + 60_000,
      allowedTools: new Set(["research.memo.persist"]),
      allowedModels: new Set(),
      agentTools: new Map([["github-researcher", new Set(["research.memo.persist"])]]),
      persistResearchMemo: async (value) => { persisted.push(value); return { ok: true }; },
      sourceStore,
      budget,
      providerMode: "fixture",
    });
    await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
    const address = gateway.server.address();
    if (!address || typeof address === "string") throw new Error("Gateway did not bind a TCP port.");
    const body = { role: "github-researcher", wave: "INITIAL", sessionId: "ses_1", memo: "Finding [S1].", encounteredSourceRefs: ["S1"], citedSourceRefs: ["S1"] };
    const response = () => fetch(`http://127.0.0.1:${address.port}/internal/tools/execute`, {
      method: "POST",
      headers: { authorization: `Bearer ${gateway.token}`, "content-type": "application/json", "x-run-id": "run-memo", "x-opencode-agent": "github-researcher" },
      body: JSON.stringify({ tool: "research.memo.persist", arguments: body }),
    });
    assert.equal((await response()).status, 200);
    assert.deepEqual(persisted, [body]);
    gateway.setPhase("PUBLISHING");
    assert.equal((await response()).status, 403);
    gateway.cancel();
    await new Promise<void>((resolve, reject) => gateway.server.close((error) => error ? reject(error) : resolve()));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("allows only the lead to publish structured findings during the publishing phase", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-report-gateway-"));
  try {
    await mkdir(join(directory, "input"), { recursive: true });
    await writeFile(join(directory, "input", "document.json"), JSON.stringify({
      pages: [{ page: 1, lines: [{ line: 1, text: "Principal Software Engineer" }] }],
    }));
    const sourceStore = await FileSourceStore.open(directory);
    const source = await sourceStore.capture({
      kind: "SOURCE_CONTENT",
      provider: "fixture",
      providerRoute: "fixture.source",
      sourceUrl: "https://example.com/profile",
      mimeType: "text/plain",
      content: "Principal Software Engineer",
      provenance: {},
    });
    const reportStore = await ReportStore.open(directory, {
      runId: "run-report",
      inputSha256: "a".repeat(64),
      startedAt: "2026-08-14T00:00:00.000Z",
      runtime: "LOCAL",
      model: "research-model",
      sourceStore,
    });
    const budget = new MemoryRunBudget({ modelUsd: 5, providerUsd: 10, externalNetworkCalls: 300, repositoryClones: 3, socialProfiles: 1 });
    const reportTools = ["report.summary.set", "report.finding.upsert", "report.finding.remove", "report.progress.get", "report.finalize"];
    const gateway = createHeadlessGateway({
      runId: "run-report",
      deadlineAt: Date.now() + 60_000,
      allowedTools: new Set([...reportTools, "web.search"]),
      allowedModels: new Set(),
      agentTools: new Map([
        ["lead-researcher", new Set([...reportTools, "web.search"])],
        ["web-records-researcher", new Set()],
      ]),
      reportStore,
      sourceStore,
      budget,
      providerMode: "fixture",
    });
    await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
    const address = gateway.server.address();
    if (!address || typeof address === "string") throw new Error("Gateway did not bind a TCP port.");
    const origin = `http://127.0.0.1:${address.port}`;
    const headers = {
      authorization: `Bearer ${gateway.token}`,
      "content-type": "application/json",
      "x-run-id": "run-report",
      "x-opencode-agent": "lead-researcher",
    };
    const execute = (tool: string, args: unknown, requestHeaders = headers) => fetch(`${origin}/internal/tools/execute`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({ tool, arguments: args, operational: { agent: requestHeaders["x-opencode-agent"], sessionId: "lead-session", callId: "call-1" } }),
    });

    assert.equal((await execute("report.summary.set", { summary: "Summary" })).status, 403);
    gateway.setPhase("PUBLISHING");
    assert.equal((await execute("web.search", { query: "must not run" })).status, 403);
    assert.equal((await execute("report.summary.set", { summary: "Summary" }, { ...headers, "x-opencode-agent": "web-records-researcher" })).status, 403);
    assert.equal((await execute("report.summary.set", { summary: "Summary" })).status, 200);

    const invalid = await execute("report.finding.upsert", {
      findingId: "F001",
      section: "Career",
      claim: "Current role",
      anchor: { kind: "PDF_TEXT", page: 1, lineStart: 1, lineEnd: 1, exact: "Wrong text" },
      evidence: "Consistent public evidence.",
      status: 2,
      sourceRefs: [source.ref],
    });
    assert.equal(invalid.status, 422);
    assert.deepEqual(await invalid.json(), { error: { code: "INVALID_ANCHOR", field: "anchor.exact", message: "anchor.exact was not found in the specified résumé page and line range." } });

    assert.equal((await execute("report.finding.upsert", {
      findingId: "F001",
      section: "Career",
      claim: "Current role",
      anchor: { kind: "PDF_TEXT", page: 1, lineStart: 1, lineEnd: 1, exact: "Principal Software Engineer" },
      evidence: "Consistent public evidence.",
      status: 2,
      sourceRefs: [source.ref],
    })).status, 200);
    const progress = await execute("report.progress.get", {});
    assert.equal(progress.status, 200);
    assert.equal((await progress.json() as { findings: unknown[] }).findings.length, 1);
    assert.equal((await execute("report.finalize", {})).status, 200);
    const events = (await readFile(join(directory, ".work", "report-events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.map(({ tool, sessionId, agent, callId }) => ({ tool, sessionId, agent, callId })), [
      { tool: "report.summary.set", sessionId: "lead-session", agent: "lead-researcher", callId: "call-1" },
      { tool: "report.finding.upsert", sessionId: "lead-session", agent: "lead-researcher", callId: "call-1" },
      { tool: "report.progress.get", sessionId: "lead-session", agent: "lead-researcher", callId: "call-1" },
      { tool: "report.finalize", sessionId: "lead-session", agent: "lead-researcher", callId: "call-1" },
    ]);

    gateway.cancel();
    await new Promise<void>((resolve, reject) => gateway.server.close((error) => error ? reject(error) : resolve()));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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

test("routes MiniMax finalizer traffic through Anthropic Messages only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-anthropic-gateway-"));
  try {
    const sourceStore = await FileSourceStore.open(directory);
    const budget = new MemoryRunBudget({ modelUsd: 5, providerUsd: 10, externalNetworkCalls: 300, repositoryClones: 3, socialProfiles: 1 });
    const gateway = createHeadlessGateway({
      runId: "run-anthropic",
      deadlineAt: Date.now() + 60_000,
      allowedTools: new Set(),
      allowedModels: new Set(["minimax-m3"]),
      agentTools: new Map([["evidence-compiler", new Set()]]),
      sourceStore,
      budget,
      providerMode: "fixture",
      finalizerModel: "minimax-m3",
      finalizerProvider: "GO",
      fixtureCompletion: async () => ({ content: "fixture anthropic response" }),
    });
    await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
    const address = gateway.server.address();
    if (!address || typeof address === "string") throw new Error("Gateway did not bind a TCP port.");
    const origin = `http://127.0.0.1:${address.port}`;
    const headers = {
      "x-api-key": gateway.token,
      "content-type": "application/json",
      "x-run-id": "run-anthropic",
      "x-opencode-agent": "evidence-compiler",
    };
    const messages = await fetch(`${origin}/internal/llm/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "minimax-m3", messages: [{ role: "user", content: "bounded" }] }),
    });
    assert.equal(messages.status, 200);
    const messageBody = await messages.json() as { type: string; role: string; content: Array<{ type: string; text?: string }> };
    assert.equal(messageBody.type, "message");
    assert.equal(messageBody.role, "assistant");
    assert.equal(messageBody.content[0]?.text, "fixture anthropic response");

    const wrongProtocol = await fetch(`${origin}/internal/llm/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "minimax-m3", messages: [{ role: "user", content: "bounded" }] }),
    });
    assert.equal(wrongProtocol.status, 400);
    gateway.cancel();
    await new Promise<void>((resolve, reject) => gateway.server.close((error) => error ? reject(error) : resolve()));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("official-domain registration is a lead-only host proposal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-domain-gateway-"));
  try {
    const sourceStore = await FileSourceStore.open(directory);
    const budget = new MemoryRunBudget({ modelUsd: 5, providerUsd: 10, externalNetworkCalls: 300, repositoryClones: 3, socialProfiles: 1 });
    const proposals: unknown[] = [];
    const gateway = createHeadlessGateway({
      runId: "run-domain",
      deadlineAt: Date.now() + 60_000,
      allowedTools: new Set(["official_domain.register"]),
      allowedModels: new Set(),
      agentTools: new Map([
        ["lead-researcher", new Set(["official_domain.register"])],
        ["web-records-researcher", new Set()],
      ]),
      officialDomainRegistration: async (value) => {
        proposals.push(value);
        return { status: "REJECTED", rejectionReason: "A domain cannot authenticate itself." };
      },
      sourceStore,
      budget,
      providerMode: "fixture",
    });
    await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
    const address = gateway.server.address();
    if (!address || typeof address === "string") throw new Error("Gateway did not bind a TCP port.");
    const origin = `http://127.0.0.1:${address.port}`;
    const body = JSON.stringify({ tool: "official_domain.register", arguments: { organization: "Organization Alpha", url: "https://organization.test", proofs: [] } });
    const baseHeaders = { authorization: `Bearer ${gateway.token}`, "content-type": "application/json", "x-run-id": "run-domain" };

    const specialist = await fetch(`${origin}/internal/tools/execute`, { method: "POST", headers: { ...baseHeaders, "x-opencode-agent": "web-records-researcher" }, body });
    assert.equal(specialist.status, 403);
    const lead = await fetch(`${origin}/internal/tools/execute`, { method: "POST", headers: { ...baseHeaders, "x-opencode-agent": "lead-researcher" }, body });
    assert.equal(lead.status, 200);
    assert.deepEqual(proposals, [{ organization: "Organization Alpha", url: "https://organization.test", proofs: [] }]);
    gateway.cancel();
    await new Promise<void>((resolve, reject) => gateway.server.close((error) => error ? reject(error) : resolve()));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
