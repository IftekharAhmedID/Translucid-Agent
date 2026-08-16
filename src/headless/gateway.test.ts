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

test("persists specialist memos during research and denies them during publishing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-memo-gateway-"));
  try {
    const sourceStore = await FileSourceStore.open(directory);
    const persisted: unknown[] = [];
    const gateway = createHeadlessGateway({
      runId: "run-memo",
      deadlineAt: Date.now() + 60_000,
      allowedTools: new Set(["research.memo.persist"]),
      allowedModels: new Set(),
      agentTools: new Map([["github-researcher", new Set(["research.memo.persist"])] ]),
      persistResearchMemo: async (value) => { persisted.push(value); return { ok: true }; },
      sourceStore,
      budget: budget(),
      providerMode: "fixture",
    });
    const server = await listen(gateway);
    const headers = { authorization: `Bearer ${gateway.token}`, "content-type": "application/json", "x-run-id": "run-memo", "x-opencode-agent": "github-researcher" };
    const response = () => fetch(`${server.origin}/internal/tools/execute`, { method: "POST", headers, body: JSON.stringify({ tool: "research.memo.persist", arguments: { sessionId: "ses_1", memo: "Finding [S1]." } }) });
    assert.equal((await response()).status, 200);
    assert.deepEqual(persisted, [{ sessionId: "ses_1", memo: "Finding [S1]." }]);
    gateway.setPhase("DRAFTING");
    assert.equal((await response()).status, 403);
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
      agentTools: new Map([["lead-researcher", new Set(reportTools)], ["web-records-researcher", new Set()]]),
      reportStore,
      sourceStore,
      budget: budget(),
      providerMode: "fixture",
    });
    const server = await listen(gateway);
    const headers = { authorization: `Bearer ${gateway.token}`, "content-type": "application/json", "x-run-id": "run-report", "x-opencode-agent": "lead-researcher" };
    const execute = (tool: string, args: unknown, override = headers) => fetch(`${server.origin}/internal/tools/execute`, { method: "POST", headers: override, body: JSON.stringify({ tool, arguments: args, operational: { sessionId: "lead-session", callId: "call-1" } }) });
    assert.equal((await execute("report.summary.set", { summary: "Summary" })).status, 403);
    gateway.setPhase("DRAFTING");
    assert.equal((await execute("web.search", { query: "must not run" })).status, 403);
    assert.equal((await execute("report.summary.set", { summary: "Summary" }, { ...headers, "x-opencode-agent": "web-records-researcher" })).status, 403);
    assert.equal((await execute("report.summary.set", { summary: "Summary" })).status, 200);
    assert.equal((await execute("report.finding.upsert", { findingId: "F001", section: "Career", claim: "Current role", anchor: { kind: "PDF_TEXT", page: 1, lineStart: 1, lineEnd: 1, exact: "Wrong text" }, evidence: "Evidence", status: 2, sourceRefs: [source.ref] })).status, 422);
    assert.equal((await execute("report.finding.upsert", { findingId: "F001", section: "Career", claim: "Current role", anchor: { kind: "PDF_TEXT", page: 1, lineStart: 1, lineEnd: 1, exact: "Principal Software Engineer" }, evidence: "Evidence", status: 2, sourceRefs: [source.ref] })).status, 200);
    assert.equal((await execute("report.finalize", {})).status, 403);
    gateway.setPhase("AUDITING");
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
    const ledgers: unknown[] = [];
    const gateway = createHeadlessGateway({ runId: "run-gateway", deadlineAt: Date.now() + 60_000, allowedTools: new Set(["web.search", "source.excerpts", "research.ledger.upsert"]), allowedModels: new Set(), executor, sourceStore, budget: runBudget, providerMode: "fixture", persistResearchLedger: async (value) => { ledgers.push(value); return { ok: true }; } });
    const server = await listen(gateway);
    const headers = { authorization: `Bearer ${gateway.token}`, "content-type": "application/json", "x-run-id": "run-gateway" };
    const provider = await fetch(`${server.origin}/internal/tools/execute`, { method: "POST", headers, body: JSON.stringify({ tool: "web.search", arguments: { query: "Synthetic Candidate Principal Engineer" }, operational: { agent: "web-records-researcher", sessionId: "session-a" } }) });
    assert.equal(provider.status, 200);
    assert.deepEqual((await provider.json() as { sourceRefs: string[] }).sourceRefs, ["S1"]);
    const ledger = await fetch(`${server.origin}/internal/tools/execute`, { method: "POST", headers, body: JSON.stringify({ tool: "research.ledger.upsert", arguments: { entries: [{ sourceRef: "S1", disposition: "EVIDENCE", relevance: "fixture evidence", sourceFamily: "employer", claimLane: "chronology" }] }, operational: { agent: "web-records-researcher", sessionId: "session-a" } }) });
    assert.equal(ledger.status, 200);
    assert.deepEqual((ledgers[0] as { encounteredSourceRefs: string[] }).encounteredSourceRefs, ["S1"]);
    const excerpt = await fetch(`${server.origin}/internal/tools/execute`, { method: "POST", headers, body: JSON.stringify({ tool: "source.excerpts", arguments: { sourceRef: "S1", queries: ["Principal Engineer"] } }) });
    assert.equal(excerpt.status, 200);
    assert.match((await excerpt.json() as { excerpts: Array<{ text: string }> }).excerpts[0]?.text ?? "", /Principal Engineer/);
    gateway.setPhase("DRAFTING");
    assert.equal((await fetch(`${server.origin}/internal/tools/execute`, { method: "POST", headers, body: JSON.stringify({ tool: "web.search", arguments: { query: "blocked" } }) })).status, 403);
    gateway.cancel();
    await server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("routes source.index during research and preserves read-only frozen recovery in publishing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-index-gateway-"));
  try {
    const sourceStore = await FileSourceStore.open(directory);
    await sourceStore.capture({ kind: "SOURCE_CONTENT", provider: "fixture", providerRoute: "fixture.web.fetch", sourceUrl: "https://example.test/source", mimeType: "text/plain", content: "A captured material phrase.", provenance: {} });
    const gateway = createHeadlessGateway({
      runId: "run-index",
      deadlineAt: Date.now() + 60_000,
      allowedTools: new Set(["source.index", "web.search"]),
      allowedModels: new Set(),
      sourceStore,
      budget: budget(),
      providerMode: "fixture",
    });
    const server = await listen(gateway);
    const headers = { authorization: `Bearer ${gateway.token}`, "content-type": "application/json", "x-run-id": "run-index" };
    const execute = (tool: string, argumentsValue: unknown) => fetch(`${server.origin}/internal/tools/execute`, { method: "POST", headers, body: JSON.stringify({ tool, arguments: argumentsValue, operational: { sessionId: "lead-session", agent: "lead-researcher" } }) });
    const indexed = await execute("source.index", { queries: ["material phrase"] });
    assert.equal(indexed.status, 200);
    assert.equal((await indexed.json() as Array<{ sourceRef: string }>)[0]?.sourceRef, "S1");
    gateway.setPhase("DRAFTING");
    assert.equal((await execute("source.index", { queries: ["material phrase"] })).status, 200);
    assert.equal((await execute("web.search", { query: "blocked" })).status, 403);
    gateway.cancel();
    await server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tracks session source ownership for notebook and ledger tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-research-tools-gateway-"));
  try {
    const sourceStore = await FileSourceStore.open(directory);
    await sourceStore.capture({ kind: "SOURCE_CONTENT", provider: "fixture", providerRoute: "fixture.web.fetch", sourceUrl: "https://example.test/source", mimeType: "text/plain", content: "Owned evidence.", provenance: {} });
    const notebooks: unknown[] = [];
    const ledgers: unknown[] = [];
    const gateway = createHeadlessGateway({
      runId: "run-research-tools",
      deadlineAt: Date.now() + 60_000,
      allowedTools: new Set(["source.index", "research.notebook.set", "research.ledger.upsert"]),
      allowedModels: new Set(),
      agentTools: new Map([["lead-researcher", new Set(["source.index", "research.notebook.set", "research.ledger.upsert"])]]),
      persistResearchNotebook: async (value) => { notebooks.push(value); return { ok: true }; },
      persistResearchLedger: async (value) => { ledgers.push(value); return { ok: true }; },
      sourceStore,
      budget: budget(),
      providerMode: "fixture",
    });
    const server = await listen(gateway);
    const headers = { authorization: `Bearer ${gateway.token}`, "content-type": "application/json", "x-run-id": "run-research-tools", "x-opencode-agent": "lead-researcher" };
    const execute = (tool: string, argumentsValue: unknown) => fetch(`${server.origin}/internal/tools/execute`, { method: "POST", headers, body: JSON.stringify({ tool, arguments: argumentsValue, operational: { sessionId: "lead-session", agent: "lead-researcher" } }) });
    assert.equal((await execute("source.index", { queries: ["Owned evidence"] })).status, 200);
    assert.equal((await execute("research.ledger.upsert", { entries: [{ sourceRef: "S1", disposition: "EVIDENCE", relevance: "owned", sourceFamily: "fixture", claimLane: "identity" }] })).status, 200);
    assert.equal((await execute("research.notebook.set", { markdown: "# Investigation", recoverySummary: "## Active claim lanes\nidentity\n\n## Strongest source refs\nS1\n\n## Contradictions\nnone\n\n## Unresolved material facets\nnone\n\n## Current search leads\nnone\n\n## Next actions\nnone\n\n## Stop decisions\nnone" })).status, 200);
    assert.equal((ledgers[0] as { sessionId: string }).sessionId, "lead-session");
    assert.deepEqual((ledgers[0] as { encounteredSourceRefs: string[] }).encounteredSourceRefs, ["S1"]);
    assert.equal((notebooks[0] as { markdown: string }).markdown, "# Investigation");
    gateway.setPhase("DRAFTING");
    assert.equal((await execute("research.ledger.upsert", { entries: [] })).status, 403);
    gateway.cancel();
    await server.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
