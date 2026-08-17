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

function budget(): MemoryRunBudget {
  return new MemoryRunBudget({ modelUsd: 5, providerUsd: 10, externalNetworkCalls: 300, repositoryClones: 3, socialProfiles: 1 });
}

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
    let snapshots = 0;
    const gateway = createHeadlessGateway({
      runId: "run-state",
      deadlineAt: Date.now() + 60_000,
      allowedTools: new Set(["research.state.set", "web.search", "report.progress.get"]),
      allowedModels: new Set(),
      agentTools: new Map([["lead-researcher", new Set(["research.state.set", "web.search", "report.progress.get"])] ]),
      researchState,
      onResearchStateSet: () => { snapshots += 1; },
      executor,
      sourceStore,
      budget: runBudget,
      providerMode: "fixture",
    });
    const server = await listen(gateway);
    const headers = { authorization: `Bearer ${gateway.token}`, "content-type": "application/json", "x-run-id": "run-state", "x-opencode-agent": "lead-researcher" };
    const execute = (tool: string, args: unknown) => fetch(`${server.origin}/internal/tools/execute`, { method: "POST", headers, body: JSON.stringify({ tool, arguments: args, operational: { sessionId: "lead-session" } }) });
    assert.equal((await execute("web.search", { query: "blocked before fixture" })).status, 200);
    gateway.freezeResearch();
    assert.equal((await execute("web.search", { query: "blocked after freeze" })).status, 403);
    assert.equal((await execute("report.progress.get", {})).status, 403);
    assert.equal((await execute("research.state.set", { publicationReady: true, claims: [{ id: "F001", claim: "Record exists", provisionalStatus: "established", supportingRefs: ["S1"], conflictingRefs: [], remainingGap: null, importance: "material" }] })).status, 200);
    assert.equal(snapshots, 1);
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
    const reportStore = await ReportStore.open(directory, { runId: "run-report", inputSha256: "a".repeat(64), startedAt: "2026-08-14T00:00:00.000Z", runtime: "LOCAL", model: "research-model", sourceStore });
    const reportTools = ["report.summary.set", "report.finding.upsert", "report.finding.remove", "report.progress.get", "report.finalize"];
    const gateway = createHeadlessGateway({
      runId: "run-report",
      deadlineAt: Date.now() + 60_000,
      allowedTools: new Set([...reportTools, "web.search"]),
      allowedModels: new Set(),
      agentTools: new Map([["lead-researcher", new Set(reportTools)], ["other-agent", new Set()]]),
      reportStore,
      sourceStore,
      budget: budget(),
      providerMode: "fixture",
    });
    const server = await listen(gateway);
    const headers = { authorization: `Bearer ${gateway.token}`, "content-type": "application/json", "x-run-id": "run-report", "x-opencode-agent": "lead-researcher" };
    const execute = (tool: string, args: unknown, override = headers) => fetch(`${server.origin}/internal/tools/execute`, { method: "POST", headers: override, body: JSON.stringify({ tool, arguments: args, operational: { sessionId: "lead-session", callId: "call-1" } }) });
    assert.equal((await execute("report.summary.set", { summary: "Summary" })).status, 403);
    gateway.setPhase("PUBLISHING");
    assert.equal((await execute("web.search", { query: "must not run" })).status, 403);
    assert.equal((await execute("report.summary.set", { summary: "Summary" }, { ...headers, "x-opencode-agent": "other-agent" })).status, 403);
    assert.equal((await execute("report.summary.set", { summary: "Summary" })).status, 200);
    assert.equal((await execute("report.finding.upsert", { findingId: "F001", section: "Career", claim: "Current role", anchor: { kind: "PDF_TEXT", page: 1, lineStart: 1, lineEnd: 1, exact: "Wrong text" }, evidence: "Evidence", status: 2, sourceRefs: [source.ref] })).status, 422);
    assert.equal((await execute("report.finding.upsert", { findingId: "F001", section: "Career", claim: "Current role", anchor: { kind: "PDF_TEXT", page: 1, lineStart: 1, lineEnd: 1, exact: "Principal Software Engineer" }, evidence: "Evidence", status: 2, sourceRefs: [source.ref] })).status, 200);
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
    const gateway = createHeadlessGateway({ runId: "run-gateway", deadlineAt: Date.now() + 60_000, allowedTools: new Set(["web.search", "source.inventory", "source.excerpts"]), allowedModels: new Set(), agentTools: new Map([["lead-researcher", new Set(["web.search", "source.inventory", "source.excerpts"])]]), executor, sourceStore, budget: runBudget, providerMode: "fixture" });
    const server = await listen(gateway);
    const headers = { authorization: `Bearer ${gateway.token}`, "content-type": "application/json", "x-run-id": "run-gateway", "x-opencode-agent": "lead-researcher" };
    const provider = await fetch(`${server.origin}/internal/tools/execute`, { method: "POST", headers, body: JSON.stringify({ tool: "web.search", arguments: { query: "Synthetic Candidate Principal Engineer" }, operational: { agent: "lead-researcher", sessionId: "session-a" } }) });
    assert.equal(provider.status, 200);
    assert.deepEqual((await provider.json() as { sourceRefs: string[] }).sourceRefs, ["S1"]);
    const inventory = await fetch(`${server.origin}/internal/tools/execute`, { method: "POST", headers, body: JSON.stringify({ tool: "source.inventory", arguments: { limit: 100 }, operational: { sessionId: "session-a" } }) });
    assert.equal(inventory.status, 200);
    assert.deepEqual((await inventory.json() as { sources: Array<Record<string, unknown>> }).sources, [{ ref: "S1", url: "https://example.test/fixtures/web.search", title: null, date: null, route: "fixture.web.search", highlight: null, sourceKind: "PROVIDER_RESPONSE", citationEligible: true }]);
    const excerpt = await fetch(`${server.origin}/internal/tools/execute`, { method: "POST", headers, body: JSON.stringify({ tool: "source.excerpts", arguments: { sourceRef: "S1", queries: ["Principal Engineer"] } }) });
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
