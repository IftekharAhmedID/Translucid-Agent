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
import { ResearchStateStore } from "./research-state.ts";

function budget(): MemoryRunBudget {
  return new MemoryRunBudget({ modelUsd: 5, providerUsd: 10, externalNetworkCalls: 300, repositoryClones: 3, socialProfiles: 1 });
}

test("the gateway verifies and records the sanitized medium reasoning effort", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-reasoning-gateway-"));
  try {
    const sourceStore = await FileSourceStore.open(directory);
    const gateway = createHeadlessGateway({
      runId: "run-reasoning",
      allowedTools: new Set(),
      allowedModels: new Set(["deepseek-v4-pro"]),
      agentTools: new Map([[
        "lead-researcher",
        new Set(),
      ]]),
      sourceStore,
      budget: budget(),
      providerMode: "fixture",
      expectedReasoningEffort: "medium",
      fixtureCompletion: async () => ({ content: "ok" }),
    });
    gateway.setLeadSession("lead-reasoning");
    const server = await listen(gateway);
    const headers = { authorization: `Bearer ${gateway.token}`, "content-type": "application/json", "x-run-id": "run-reasoning", "x-opencode-agent": "lead-researcher" };
    const request = (reasoning_effort: string) => fetch(`${server.origin}/internal/llm/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ model: "deepseek-v4-pro", messages: [{ role: "user", content: "hello" }], reasoning_effort, stream: false }) });
    assert.equal((await request("medium")).status, 200);
    assert.equal((await request("high")).status, 400);
    assert.deepEqual(gateway.telemetry().observedReasoningEfforts, ["medium"]);
    gateway.cancel();
    await server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function listen(gateway: ReturnType<typeof createHeadlessGateway>): Promise<{ origin: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address();
  if (!address || typeof address === "string") throw new Error("Gateway did not bind a TCP port.");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => gateway.server.close((error) => error ? reject(error) : resolve())),
  };
}

test("freezes providers only after model-authored claim state is durably set", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-state-gateway-"));
  try {
    const sourceStore = await FileSourceStore.open(directory);
    await sourceStore.capture({ kind: "SOURCE_CONTENT", provider: "fixture", providerRoute: "fixture.record", sourceUrl: "https://example.test/record", mimeType: "text/plain", content: "Record", provenance: {} });
    const { ResearchStateStore } = await import("./research-state.ts");
    const researchState = await ResearchStateStore.open(directory, sourceStore);
    const runBudget = budget();
    const executor = new ProviderExecutor({ PROVIDER_MODE: "fixture" }, createFileProviderBackend({ sourceStore, budget: runBudget, deadlineAt: Date.now() + 60_000 }));
    const gateway = createHeadlessGateway({
      runId: "run-state",
      deadlineAt: Date.now() + 60_000,
      allowedTools: new Set(["research.state.set", "research.state.get", "web.search", "report.progress.get"]),
      allowedModels: new Set(),
      agentTools: new Map([["lead-researcher", new Set(["research.state.set", "research.state.get", "web.search", "report.progress.get"])] ]),
      researchState,
      executor,
      sourceStore,
      budget: runBudget,
      providerMode: "fixture",
    });
    gateway.setLeadSession("lead-session");
    const server = await listen(gateway);
    const headers = { authorization: `Bearer ${gateway.token}`, "content-type": "application/json", "x-run-id": "run-state", "x-opencode-agent": "lead-researcher" };
    const execute = (tool: string, args: unknown) => fetch(`${server.origin}/internal/tools/execute`, { method: "POST", headers, body: JSON.stringify({ tool, arguments: args, operational: { sessionId: "lead-session" } }) });
    assert.equal((await execute("web.search", { query: "blocked before fixture" })).status, 200);
    assert.equal((await execute("research.state.set", { publicationReady: true, claims: [{ id: "F001", claim: "Record exists", provisionalStatus: "established", supportingRefs: ["S1"], conflictingRefs: [], remainingGap: null, importance: "material" }] })).status, 200);
    gateway.freezeResearch();
    assert.equal((await execute("web.search", { query: "blocked after freeze" })).status, 403);
    assert.equal((await execute("report.progress.get", {})).status, 403);
    assert.equal((await execute("research.state.set", { publicationReady: true, claims: [{ id: "F002", claim: "Late write", provisionalStatus: "established", supportingRefs: [], conflictingRefs: [], remainingGap: null, importance: "material" }] })).status, 403);
    assert.equal((await execute("research.state.get", {})).status, 200);
    gateway.cancel();
    await server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("allows only the lead to publish structurally valid findings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-report-gateway-"));
  try {
    await mkdir(join(directory, "input"), { recursive: true });
    await writeFile(join(directory, "input", "document.json"), JSON.stringify({ pages: [{ page: 1, lines: [{ line: 1, text: "Principal Software Engineer" }] }] }));
    const sourceStore = await FileSourceStore.open(directory);
    const source = await sourceStore.capture({ kind: "SOURCE_CONTENT", provider: "fixture", providerRoute: "fixture.source", sourceUrl: "https://example.com/profile", mimeType: "text/plain", content: "Principal Software Engineer", provenance: {} });
    const researchState = await ResearchStateStore.open(directory, sourceStore);
    await researchState.set({ publicationReady: true, claims: [{ id: "C1", claim: "Current role", provisionalStatus: "established", supportingRefs: [source.ref], conflictingRefs: [], remainingGap: null, importance: "material" }] });
    const reportStore = await ReportStore.open(directory, { runId: "run-report", inputSha256: "a".repeat(64), startedAt: "2026-08-14T00:00:00.000Z", runtime: "LOCAL", model: "research-model", sourceStore, researchState });
    await reportStore.bindResearchSnapshot("d".repeat(64));
    const reportTools = ["report.summary.set", "report.finding.upsert", "report.finding.remove", "report.progress.get", "report.finalize"];
    const gateway = createHeadlessGateway({
      runId: "run-report",
      deadlineAt: Date.now() + 60_000,
      allowedTools: new Set([...reportTools, "web.search"]),
      allowedModels: new Set(),
      agentTools: new Map([["lead-researcher", new Set(reportTools)], ["other-agent", new Set()]]),
      reportStore,
      researchState,
      sourceStore,
      budget: budget(),
      providerMode: "fixture",
    });
    gateway.setLeadSession("lead-session");
    const server = await listen(gateway);
    const headers = { authorization: `Bearer ${gateway.token}`, "content-type": "application/json", "x-run-id": "run-report", "x-opencode-agent": "lead-researcher" };
    const execute = (tool: string, args: unknown, override = headers) => fetch(`${server.origin}/internal/tools/execute`, { method: "POST", headers: override, body: JSON.stringify({ tool, arguments: args, operational: { sessionId: "lead-session", callId: "call-1" } }) });
    assert.equal((await execute("report.summary.set", { summary: "Summary" })).status, 403);
    gateway.setPhase("PUBLISHING");
    assert.equal((await execute("web.search", { query: "must not run" })).status, 403);
    assert.equal((await execute("report.summary.set", { summary: "Summary" }, { ...headers, "x-opencode-agent": "other-agent" })).status, 403);
    assert.equal((await execute("report.summary.set", { summary: "Summary", researchClaimIds: ["C1"] })).status, 200);
    assert.equal((await execute("report.finding.upsert", { findingId: "F001", section: "Career", claim: "Current role", anchor: { kind: "PDF_TEXT", page: 1, lineStart: 1, lineEnd: 1, exact: "Wrong text" }, evidence: "Evidence", status: 2, sourceRefs: [source.ref], researchClaimIds: ["C1"] })).status, 422);
    assert.equal((await execute("report.finding.upsert", { findingId: "F001", section: "Career", claim: "Current role", anchor: { kind: "PDF_TEXT", page: 1, lineStart: 1, lineEnd: 1, exact: "Principal Software Engineer" }, evidence: "Evidence", status: 2, sourceRefs: [source.ref], researchClaimIds: ["C1"] })).status, 200);
    assert.equal((await execute("report.finalize", {})).status, 200);
    const events = (await readFile(join(directory, ".work", "report-events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.map(({ tool }: { tool: string }) => tool), ["report.summary.set", "report.finding.upsert", "report.finalize"]);
    gateway.cancel();
    await server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("routes research providers and local excerpts, then blocks providers in publishing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-headless-gateway-"));
  try {
    const sourceStore = await FileSourceStore.open(directory);
    const runBudget = budget();
    const executor = new ProviderExecutor({ PROVIDER_MODE: "fixture" }, createFileProviderBackend({ sourceStore, budget: runBudget, deadlineAt: Date.now() + 60_000 }));
    const totalDeadlineAt = Date.now() + 180_000;
    const researchCutoff = totalDeadlineAt - 120_000;
    const gateway = createHeadlessGateway({ runId: "run-gateway", deadlineAt: totalDeadlineAt, researchDeadlineAt: researchCutoff, allowedTools: new Set(["web.search", "source.inventory", "source.excerpts"]), allowedModels: new Set(), agentTools: new Map([["lead-researcher", new Set(["web.search", "source.inventory", "source.excerpts"])]]), executor, sourceStore, budget: runBudget, providerMode: "fixture" });
    gateway.setLeadSession("session-a");
    const server = await listen(gateway);
    const headers = { authorization: `Bearer ${gateway.token}`, "content-type": "application/json", "x-run-id": "run-gateway", "x-opencode-agent": "lead-researcher" };
    const provider = await fetch(`${server.origin}/internal/tools/execute`, { method: "POST", headers, body: JSON.stringify({ tool: "web.search", arguments: { query: "Synthetic Candidate Principal Engineer" }, operational: { agent: "lead-researcher", sessionId: "session-a" } }) });
    assert.equal(provider.status, 200);
    const providerBody = await provider.json() as { sourceRefs: string[]; timing?: Record<string, unknown> };
    assert.deepEqual(providerBody.sourceRefs, ["S1"]);
    assert.deepEqual(providerBody.timing, { researchDeadlineAt: researchCutoff, totalDeadlineAt });
    const inventory = await fetch(`${server.origin}/internal/tools/execute`, { method: "POST", headers, body: JSON.stringify({ tool: "source.inventory", arguments: { limit: 100 }, operational: { sessionId: "session-a" } }) });
    assert.equal(inventory.status, 200);
    assert.deepEqual((await inventory.json() as { sources: Array<Record<string, unknown>> }).sources, [{ ref: "S1", url: "https://example.test/fixtures/web.search", title: null, date: null, route: "fixture.web.search", highlight: null, sourceKind: "PROVIDER_RESPONSE", citationEligible: true }]);
    const excerpt = await fetch(`${server.origin}/internal/tools/execute`, { method: "POST", headers, body: JSON.stringify({ tool: "source.excerpts", arguments: { sourceRef: "S1", queries: ["Principal Engineer"] }, operational: { sessionId: "session-a" } }) });
    assert.equal(excerpt.status, 200);
    assert.match((await excerpt.json() as { excerpts: Array<{ text: string }> }).excerpts[0]?.text ?? "", /Principal Engineer/);
    gateway.setPhase("PUBLISHING");
    assert.equal((await fetch(`${server.origin}/internal/tools/execute`, { method: "POST", headers, body: JSON.stringify({ tool: "web.search", arguments: { query: "blocked" } }) })).status, 403);
    gateway.cancel();
    await server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("resolves a captured SEARCH_DISCOVERY reference before web.fetch and records its provenance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-discovery-ref-gateway-"));
  try {
    const sourceStore = await FileSourceStore.open(directory);
    const discovery = await sourceStore.capture({ kind: "SEARCH_DISCOVERY", provider: "exa", providerRoute: "exa.search", sourceUrl: "https://example.test/oversized-lead", mimeType: "application/json", content: { results: [{ url: "https://example.test/oversized-lead" }] }, provenance: { searchQuery: "candidate" } });
    let received: { tool?: string; arguments?: unknown; context?: Record<string, unknown> } = {};
    const executor = { executeHeadless: async (request: { tool: string; arguments: unknown }, context: Record<string, unknown>) => {
      received = { tool: request.tool, arguments: request.arguments, context };
      return { status: "OK", capability: "WEB_FETCH", provider: "fixture", sourceRefs: [], evidenceEligibleSourceRefs: [], preview: "fetched", observedAt: new Date().toISOString(), costUsd: 0, costSource: "FREE_PUBLIC", cache: "MISS" };
    } } as unknown as ProviderExecutor;
    const gateway = createHeadlessGateway({ runId: "run-discovery-ref", deadlineAt: Date.now() + 60_000, allowedTools: new Set(["web.fetch"]), allowedModels: new Set(), agentTools: new Map([["lead-researcher", new Set(["web.fetch"])] ]), executor, sourceStore, budget: budget(), providerMode: "fixture" });
    gateway.setLeadSession("session-discovery-ref");
    const server = await listen(gateway);
    const headers = { authorization: `Bearer ${gateway.token}`, "content-type": "application/json", "x-run-id": "run-discovery-ref", "x-opencode-agent": "lead-researcher" };
    const response = await fetch(`${server.origin}/internal/tools/execute`, { method: "POST", headers, body: JSON.stringify({ tool: "web.fetch", arguments: { discoveryRef: discovery.ref }, operational: { agent: "lead-researcher", sessionId: "session-discovery-ref" } }) });
    assert.equal(response.status, 200);
    assert.deepEqual(received, { tool: "web.fetch", arguments: { url: "https://example.test/oversized-lead" }, context: { runId: "run-discovery-ref", agent: "lead-researcher", sessionId: "session-discovery-ref", resolvedDiscoveryRef: discovery.ref } });
    gateway.cancel();
    await server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("freezing waits for an in-flight provider and rejects new external calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-provider-freeze-"));
  try {
    const sourceStore = await FileSourceStore.open(directory);
    let started = false;
    let release!: () => void;
    const executor = {
      executeHeadless: async () => {
        started = true;
        await new Promise<void>((resolve) => { release = resolve; });
        return { status: "OK", capability: "WEB_SEARCH", provider: "fixture", sourceRefs: [], evidenceEligibleSourceRefs: [], preview: "", observedAt: new Date().toISOString(), costUsd: 0, costSource: "FREE_PUBLIC", cache: "MISS" };
      },
    } as unknown as ProviderExecutor;
    const gateway = createHeadlessGateway({ runId: "run-freeze", deadlineAt: Date.now() + 60_000, allowedTools: new Set(["web.search"]), allowedModels: new Set(), agentTools: new Map([["lead-researcher", new Set(["web.search"])]]), executor, sourceStore, budget: budget(), providerMode: "fixture" });
    gateway.setLeadSession("session-freeze");
    const server = await listen(gateway);
    const headers = { authorization: `Bearer ${gateway.token}`, "content-type": "application/json", "x-run-id": "run-freeze", "x-opencode-agent": "lead-researcher" };
    const provider = fetch(`${server.origin}/internal/tools/execute`, { method: "POST", headers, body: JSON.stringify({ tool: "web.search", arguments: { query: "in flight" }, operational: { sessionId: "session-freeze" } }) });
    while (!started) await new Promise((resolve) => setTimeout(resolve, 1));
    const freezing = gateway.freezeResearch();
    assert.equal((await fetch(`${server.origin}/internal/tools/execute`, { method: "POST", headers, body: JSON.stringify({ tool: "web.search", arguments: { query: "blocked" } }) })).status, 403);
    let drained = false;
    void freezing.then(() => { drained = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(drained, false);
    release();
    await freezing;
    assert.equal(drained, true);
    assert.equal((await provider).status, 200);
    gateway.cancel();
    await server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("research cutoff rejects new provider and semantic mutations while total publication time remains valid", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-research-cutoff-"));
  try {
    const sourceStore = await FileSourceStore.open(directory);
    const totalDeadlineAt = Date.now() + 60_000;
    const gateway = createHeadlessGateway({ runId: "run-cutoff", deadlineAt: totalDeadlineAt, researchDeadlineAt: Date.now() - 1, allowedTools: new Set(["web.search", "investigation.plan.set"]), allowedModels: new Set(), agentTools: new Map([["lead-researcher", new Set(["web.search", "investigation.plan.set"])]]), sourceStore, budget: budget(), providerMode: "fixture" });
    gateway.setLeadSession("session-cutoff");
    const server = await listen(gateway);
    const headers = { authorization: `Bearer ${gateway.token}`, "content-type": "application/json", "x-run-id": "run-cutoff", "x-opencode-agent": "lead-researcher" };
    const execute = (tool: string) => fetch(`${server.origin}/internal/tools/execute`, { method: "POST", headers, body: JSON.stringify({ tool, arguments: {}, operational: { sessionId: "session-cutoff" } }) });
    assert.equal((await execute("web.search")).status, 403);
    assert.equal((await execute("investigation.plan.set")).status, 403);
    gateway.cancel();
    await server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v3 commit prevalidates, drains in-flight providers, and freezes all semantic writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-v3-commit-gateway-"));
  try {
    await mkdir(join(directory, "input"), { recursive: true });
    await writeFile(join(directory, "input", "document.json"), JSON.stringify({ pages: [{ page: 1, lines: [{ line: 1, text: "Synthetic Candidate" }] }] }));
    const sourceStore = await FileSourceStore.open(directory);
    const source = await sourceStore.capture({ kind: "SOURCE_CONTENT", provider: "fixture", providerRoute: "fixture.record", sourceUrl: "https://example.test/record", mimeType: "text/plain", content: "The record establishes contribution.", provenance: {} });
    const researchState = await ResearchStateStore.open(directory, sourceStore);
    let started = false;
    let release!: () => void;
    const executor = {
      executeHeadless: async () => {
        started = true;
        await new Promise<void>((resolve) => { release = resolve; });
        return { status: "OK", capability: "WEB_SEARCH", provider: "fixture", sourceRefs: [], evidenceEligibleSourceRefs: [], preview: "", observedAt: new Date().toISOString(), costUsd: 0, costSource: "FREE_PUBLIC", cache: "MISS" };
      },
    } as unknown as ProviderExecutor;
    const tools = ["investigation.plan.set", "investigation.synthesis.begin", "investigation.finding.upsert", "investigation.summary.set", "investigation.progress.get", "investigation.commit", "web.search"];
    const gateway = createHeadlessGateway({ runId: "run-v3-commit", deadlineAt: Date.now() + 60_000, allowedTools: new Set(tools), allowedModels: new Set(), agentTools: new Map([["lead-researcher", new Set(tools)]]), researchState, executor, sourceStore, budget: budget(), providerMode: "fixture" });
    gateway.setLeadSession("lead-v3");
    const server = await listen(gateway);
    const headers = { authorization: `Bearer ${gateway.token}`, "content-type": "application/json", "x-run-id": "run-v3-commit", "x-opencode-agent": "lead-researcher" };
    const execute = (tool: string, args: unknown = {}) => fetch(`${server.origin}/internal/tools/execute`, { method: "POST", headers, body: JSON.stringify({ tool, arguments: args, operational: { sessionId: "lead-v3" } }) });
    const anchor = { kind: "PDF_TEXT", page: 1, lineStart: 1, lineEnd: 1, exact: "Synthetic Candidate" };
    assert.equal((await execute("investigation.plan.set", { identityAnchors: ["Synthetic Candidate"], targets: [{ id: "contribution", section: "Career", predicate: "Made a material contribution", importance: "HIGH", anchor }] })).status, 200);
    assert.equal((await execute("investigation.synthesis.begin")).status, 200);
    assert.equal((await execute("investigation.finding.upsert", { targetId: "contribution", conclusion: "Contribution is established.", status: "ESTABLISHED", evidence: [{ sourceRef: source.ref, relation: "SUPPORTS", comment: "The record establishes contribution, not leadership." }], rationale: "Direct record.", remainingGap: null })).status, 200);
    assert.equal((await execute("investigation.summary.set", { text: "The contribution is established.", targetIds: ["contribution"] })).status, 200);
    const provider = execute("web.search", { query: "in flight" });
    while (!started) await new Promise((resolve) => setTimeout(resolve, 1));
    const commit = execute("investigation.commit");
    assert.equal((await execute("web.search", { query: "blocked during commit" })).status, 403);
    release();
    assert.equal((await provider).status, 200);
    assert.equal((await commit).status, 200);
    assert.equal((await execute("investigation.finding.upsert", { targetId: "contribution", conclusion: "Late mutation", status: "ESTABLISHED", evidence: [{ sourceRef: source.ref, relation: "SUPPORTS", comment: "Late." }], rationale: "Late.", remainingGap: null })).status, 403);
    assert.equal((await execute("web.search", { query: "blocked after commit" })).status, 403);
    assert.equal((await researchState.current())?.phase, "COMMITTED");
    gateway.cancel();
    await server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
