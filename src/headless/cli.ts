import { randomBytes, randomUUID } from "node:crypto";
import { type ChildProcess } from "node:child_process";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { toolNames } from "../providers/contracts.ts";
import { ProviderExecutor } from "../providers/executor.ts";
import { E2BRuntime } from "../runtime/e2b.ts";
import { getPinnedLocalManifestHash, LocalDockerRuntime } from "../runtime/local-docker.ts";
import type { InvestigatorRuntime, RunHandle } from "../runtime/types.ts";
import { headlessBudgetCeilings, MemoryRunBudget } from "./budget.ts";
import { parseInvestigationArguments } from "./cli-options.ts";
import { classifyInvestigationFailure, HeadlessInvestigationController, ResearchHandoffError } from "./controller.ts";
import { createHeadlessFixtureCompletion } from "./fixture-model.ts";
import { createHeadlessGateway } from "./gateway.ts";
import { persistResearchLedger, persistResearchMemo, persistResearchNotebook } from "./recovery.ts";
import { createFileProviderBackend } from "./provider-store.ts";
import { reportToolNames, ReportStore } from "./report-store.ts";
import { renderLeanReport, verifyInvestigationReport } from "./report.ts";
import { createRunWorkspace, removeRunDiagnostics, sealRunFailure, type RunWorkspace } from "./run-workspace.ts";
import { attachOpenCodeTui } from "./visible-tui.ts";

const RUN_TIMEOUT_MS = 60 * 60_000;
const PUBLISHING_RESERVE_MS = 12 * 60_000;
const SPECIALIST_MODEL = "deepseek-v4-flash";

async function atomicWrite(path: string, bytes: Uint8Array | string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, path);
}

function upstream(provider: "ZEN" | "GO"): string {
  return provider === "GO" ? "https://opencode.ai/zen/go/v1/chat/completions" : "https://opencode.ai/zen/v1/chat/completions";
}

function integerEnvironment(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function providerEnvironment(mode: "fixture" | "live"): Record<string, string | undefined> {
  return { ...process.env, PROVIDER_MODE: mode, PROVIDER_BUDGET_USD: "10", GITHUB_CLONE_CEILING: "3", SOCIAL_PROFILE_CEILING: "1" };
}

function agentToolAllowlist(): Map<string, Set<string>> {
  return new Map([
    ["lead-researcher", new Set(["source.excerpts", "source.index", "research.notebook.set", "research.ledger.upsert", ...reportToolNames])],
    ["professional-researcher", new Set(["professional.profile", "professional.activity", "web.search", "web.fetch", "archives.search", "source.excerpts", "research.ledger.upsert", "research.memo.persist"])],
    ["github-researcher", new Set(["github.graphql", "github.rest", "github.clone", "web.fetch", "source.excerpts", "research.ledger.upsert", "research.memo.persist"])],
    ["web-records-researcher", new Set(["web.search", "web.fetch", "archives.search", "public_records.search", "scholarly.search", "packages.inspect", "security_records.search", "source.excerpts", "research.ledger.upsert", "research.memo.persist"])],
    ["social-researcher", new Set(["social.profile", "source.excerpts", "research.ledger.upsert", "research.memo.persist"])],
  ]);
}

async function listen(server: ReturnType<typeof createHeadlessGateway>["server"], port: number): Promise<number> {
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", done);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Headless gateway did not bind a TCP port.");
  return address.port;
}

async function closeServer(server: ReturnType<typeof createHeadlessGateway>["server"]): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((done) => server.close(() => done()));
}

async function main(): Promise<void> {
  const options = parseInvestigationArguments(process.argv.slice(2));
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const deadlineAt = new Date(Date.now() + RUN_TIMEOUT_MS);
  let workspace: RunWorkspace | undefined;
  let runtime: InvestigatorRuntime | undefined;
  let handle: RunHandle | undefined;
  let gateway: ReturnType<typeof createHeadlessGateway> | undefined;
  let watchProcess: ChildProcess | undefined;
  let attachPath: string | undefined;
  let reportTemporaryPath: string | undefined;
  const abort = new AbortController();
  const abortHandler = () => abort.abort(new DOMException("Investigation cancelled by signal.", "AbortError"));
  process.once("SIGINT", abortHandler);
  process.once("SIGTERM", abortHandler);
  const deadline = setTimeout(() => abort.abort(new DOMException("Investigation deadline reached.", "TimeoutError")), RUN_TIMEOUT_MS);

  try {
    workspace = await createRunWorkspace({
      outputDirectory: options.outputDirectory,
      resumePath: options.resumePath,
      submissionPath: options.submissionPath,
      classification: options.classification,
      runtime: options.runtime,
      startedAt,
      runId,
    });
    const expectedManifestHash = await getPinnedLocalManifestHash();
    const researchModel = process.env.RESEARCH_MODEL ?? "gpt-5.6-luna";
    const budget = new MemoryRunBudget(headlessBudgetCeilings(), { onChange: () => undefined });
    const reportStore = await ReportStore.open(workspace.root, {
      runId,
      inputSha256: workspace.inputSha256,
      startedAt,
      runtime: options.runtime,
      model: researchModel,
      sourceStore: workspace.sourceStore,
    });
    const providerExecutor = new ProviderExecutor(providerEnvironment(options.providerMode), createFileProviderBackend({ sourceStore: workspace.sourceStore, budget, deadlineAt: deadlineAt.getTime() }));
    await providerExecutor.preflight({ runId, agent: "headless-preflight", sessionId: "headless-preflight" });
    const researchProvider = process.env.RESEARCH_OPENCODE_PROVIDER === "ZEN" ? "ZEN" : "GO";
    const fixture = createHeadlessFixtureCompletion();
    gateway = createHeadlessGateway({
      runId,
      deadlineAt: deadlineAt.getTime(),
      allowedTools: new Set([...toolNames, "source.excerpts", "source.index", "research.memo.persist", "research.notebook.set", "research.ledger.upsert", ...reportToolNames]),
      allowedModels: new Set([researchModel, SPECIALIST_MODEL]),
      agentTools: agentToolAllowlist(),
      reportStore,
      persistResearchMemo: (value) => persistResearchMemo(workspace!.root, value),
      persistResearchNotebook: (value) => persistResearchNotebook(workspace!.root, value),
      persistResearchLedger: (value) => persistResearchLedger(workspace!.root, value),
      executor: providerExecutor,
      sourceStore: workspace.sourceStore,
      budget,
      providerMode: options.providerMode,
      researchUpstreamUrl: upstream(researchProvider),
      fixtureCompletion: (body, agent) => fixture(body, agent),
    });
    const gatewayPort = await listen(gateway.server, options.runtime === "E2B" ? integerEnvironment("HEADLESS_GATEWAY_PORT", 3001) : 0);
    const localGatewayUrl = `http://127.0.0.1:${gatewayPort}`;
    const gatewayUrl = options.runtime === "E2B" ? process.env.E2B_GATEWAY_PUBLIC_URL : localGatewayUrl;
    if (options.runtime === "E2B") {
      if (!process.env.E2B_API_KEY || !process.env.E2B_TEMPLATE_ID || !gatewayUrl?.startsWith("https://")) throw new Error("E2B requires E2B_API_KEY, E2B_TEMPLATE_ID, and an HTTPS E2B_GATEWAY_PUBLIC_URL routed to this gateway.");
      if (options.watch) throw new Error("--watch currently requires the local runtime because E2B secure-access headers are not supported by opencode attach.");
      runtime = new E2BRuntime({ apiKey: process.env.E2B_API_KEY, templateId: process.env.E2B_TEMPLATE_ID });
    } else runtime = new LocalDockerRuntime();
    const password = randomBytes(24).toString("base64url");
    process.stderr.write(`Run ${runId}: starting ${options.runtime.toLowerCase()} OpenCode runtime.\n`);
    handle = await runtime.start({
      investigationId: runId,
      runId,
      caseDirectory: workspace.root,
      gatewayUrl: gatewayUrl!,
      caseToken: gateway.token,
      openCodePassword: password,
      expectedManifestHash,
      timeoutMs: RUN_TIMEOUT_MS,
      mode: "headless",
      deadlineAt: deadlineAt.toISOString(),
    });
    if (handle.kind === "LOCAL") {
      const attachDirectory = resolve(".debug", "headless");
      await mkdir(attachDirectory, { recursive: true, mode: 0o700 });
      attachPath = join(attachDirectory, `${runId}.json`);
      await writeFile(attachPath, JSON.stringify({ openCodeUrl: handle.openCodeUrl, password, title: "Headless lead research" }), { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
    const controller = new HeadlessInvestigationController();
    const output = await controller.run({
      root: workspace.root,
      handle,
      deadlineAt,
      publishingReserveMs: PUBLISHING_RESERVE_MS,
      signal: abort.signal,
      runtime: options.runtime,
      researchModel,
      reportStore,
      assertResearchReadyForPublishing: () => providerExecutor.assertReadyForPublication(),
      beginDrafting: () => gateway!.setPhase("DRAFTING"),
      beginAuditing: () => gateway!.setPhase("AUDITING"),
      onLeadStarted: async (sessionId) => {
        process.stderr.write(`Run ${runId}: lead session ${sessionId} is visible${options.watch ? " in the attached TUI" : ` with npm run attach -- ${runId}`}.\n`);
        if (options.watch && handle) watchProcess = attachOpenCodeTui(handle, password, sessionId);
      },
      onProgress: (message) => { if (!options.watch) process.stderr.write(`Run ${runId}: ${message}\n`); },
    });
    const integrity = await workspace.sourceStore.verify();
    if (!integrity.valid) throw new Error(`Source integrity failed for ${integrity.invalidSourceRefs.join(", ")}.`);
    const resultPath = join(workspace.root, "result.json");
    const reportPath = join(workspace.root, "report.pdf");
    reportTemporaryPath = `${reportPath}.tmp`;
    await rm(reportTemporaryPath, { force: true });
    await atomicWrite(reportTemporaryPath, await renderLeanReport(output.result));
    await verifyInvestigationReport(await readFile(reportTemporaryPath));
    await runtime.stop(handle);
    handle = undefined;
    await mkdir(join(workspace.root, "provenance"), { recursive: true });
    const progress = await reportStore.progress();
    await atomicWrite(join(workspace.root, "provenance", "report.json"), `${JSON.stringify({ schemaVersion: 1, runId, inputSha256: workspace.inputSha256, reportDraftRevision: progress.revision, sourceRefs: [...new Set(output.result.findings.flatMap(({ sources }) => sources.map(({ sourceRef }) => sourceRef)))].sort() }, null, 2)}\n`);
    await rename(reportTemporaryPath, reportPath);
    reportTemporaryPath = undefined;
    await reportStore.markPublished();
    if (!options.keepDebug) await removeRunDiagnostics(workspace.root);
    await atomicWrite(resultPath, `${JSON.stringify(output.result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ runId, result: resultPath, report: reportPath, sources: join(workspace.root, "sources") }, null, 2)}\n`);
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error("Unknown headless investigation failure.");
    if (workspace) {
      const failure = classifyInvestigationFailure(error, abort.signal.aborted, Boolean(handle));
      await mkdir(join(workspace.root, "diagnostics"), { recursive: true });
      await sealRunFailure(workspace.root, {
        runId,
        code: failure.code,
        message: error.message,
        phase: failure.phase,
        cancelled: abort.signal.aborted,
        diagnostics: {
          ...(handle?.kind === "E2B" ? { sandboxId: handle.id } : {}),
          ...(handle?.kind === "LOCAL" ? { sessionId: handle.id } : {}),
          ...(error instanceof ResearchHandoffError ? { researchHandoff: JSON.stringify(error.failures) } : {}),
        },
      }).catch(() => undefined);
    }
    process.stderr.write(`Run ${runId} failed: ${error.message}\n`);
    process.exitCode = 1;
    if (runtime && handle) await runtime.stop(handle).catch(() => undefined);
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGINT", abortHandler);
    process.removeListener("SIGTERM", abortHandler);
    if (attachPath) await rm(attachPath, { force: true });
    if (reportTemporaryPath) await rm(reportTemporaryPath, { force: true });
    if (watchProcess && !watchProcess.killed) watchProcess.kill("SIGTERM");
    gateway?.cancel();
    if (gateway) await closeServer(gateway.server);
  }
}

await main();
