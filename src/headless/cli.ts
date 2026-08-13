import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { toolNames } from "../providers/contracts.ts";
import { FINALIZER_MODEL_CATALOG, PAID_GO_MODEL_IDS } from "../core/model-catalog.ts";
import { loadModelRequestTimeouts } from "../core/config.ts";
import { ProviderExecutor } from "../providers/executor.ts";
import { E2BRuntime } from "../runtime/e2b.ts";
import { getPinnedLocalManifestHash, getPinnedResearchManifestHash, LocalDockerRuntime } from "../runtime/local-docker.ts";
import type { InvestigatorRuntime, RunHandle } from "../runtime/types.ts";
import { currentCheckpointConfigs } from "./checkpoint-config.ts";
import { openPersistentRunBudget } from "./checkpoint.ts";
import { parseInvestigationArguments } from "./cli-options.ts";
import { HeadlessInvestigationController } from "./controller.ts";
import { createHeadlessFixtureCompletion } from "./fixture-model.ts";
import { publishFinalizationProvenance } from "./incremental-pipeline.ts";
import { createHeadlessGateway } from "./gateway.ts";
import { createFileProviderBackend } from "./provider-store.ts";
import { renderInvestigationReport, verifyInvestigationReport } from "./report.ts";
import { assertPublishableResult } from "./result-contract.ts";
import { createRunWorkspace, removeRunDiagnostics, sealRunFailure, type RunWorkspace } from "./run-workspace.ts";

const RUN_TIMEOUT_MS = 60 * 60_000;
const FINALIZATION_RESERVE_MS = 12 * 60_000;

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
    ["lead-researcher", new Set(["source.excerpts"])],
    ["professional-researcher", new Set(["professional.profile", "professional.activity", "web.search", "web.fetch", "archives.search", "source.excerpts"])],
    ["github-researcher", new Set(["github.graphql", "github.rest", "github.clone", "web.fetch", "source.excerpts"])],
    ["web-records-researcher", new Set(["web.search", "web.fetch", "archives.search", "public_records.search", "scholarly.search", "packages.inspect", "security_records.search", "source.excerpts"])],
    ["social-researcher", new Set(["social.profile", "source.excerpts"])],
    ["evidence-compiler", new Set()],
    ["evidence-auditor", new Set()],
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

function attachTui(handle: RunHandle, password: string, sessionId: string): ChildProcess {
  return spawn(resolve("node_modules", ".bin", "opencode"), ["attach", handle.openCodeUrl, "--session", sessionId], {
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
    stdio: "inherit",
  });
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
    const researchManifestHash = await getPinnedResearchManifestHash();
    const researchModel = process.env.RESEARCH_MODEL ?? "deepseek-v4-flash";
    const compilerModel = process.env.FINALIZER_MODEL ?? "deepseek-v4-pro";
    const auditorModel = process.env.FINALIZER_AUDITOR_MODEL ?? "minimax-m3";
    const checkpointConfigs = await currentCheckpointConfigs({
      repositoryRoot: process.cwd(),
      runtime: options.runtime,
      providerMode: options.providerMode,
      researchModel,
      compilerModel,
      runtimeManifestHash: researchManifestHash,
    });
    const budget = await openPersistentRunBudget(workspace.root, { modelUsd: 5, providerUsd: 10, externalNetworkCalls: 300, repositoryClones: 3, socialProfiles: 1 });
    const providerExecutor = new ProviderExecutor(providerEnvironment(options.providerMode), createFileProviderBackend({ sourceStore: workspace.sourceStore, budget, deadlineAt: deadlineAt.getTime() }));
    const researchProvider = process.env.RESEARCH_OPENCODE_PROVIDER === "ZEN" ? "ZEN" : "GO";
    const finalizerProvider = process.env.FINALIZER_OPENCODE_PROVIDER === "ZEN" ? "ZEN" : "GO";
    const fixture = createHeadlessFixtureCompletion();
    gateway = createHeadlessGateway({
      runId,
      deadlineAt: deadlineAt.getTime(),
      allowedTools: new Set([...toolNames, "source.excerpts"]),
      allowedModels: new Set([researchModel, compilerModel, auditorModel, ...PAID_GO_MODEL_IDS, ...FINALIZER_MODEL_CATALOG.map(({ id }) => id)]),
      agentTools: agentToolAllowlist(),
      executor: providerExecutor,
      sourceStore: workspace.sourceStore,
      budget,
      providerMode: options.providerMode,
      researchUpstreamUrl: upstream(researchProvider),
      finalizerUpstreamUrl: upstream(finalizerProvider),
      finalizerProvider,
      finalizerModel: compilerModel,
      modelRequestTimeouts: loadModelRequestTimeouts(process.env),
      fixtureCompletion: (body, agent) => fixture(body, agent),
      onModelRequest: ({ agent, estimatedInputTokens }) => {
        if (agent === "evidence-compiler" || agent === "evidence-auditor") process.stderr.write(`Run ${runId}: ${agent} request estimated input tokens ${estimatedInputTokens}.\n`);
      },
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
      runId,
      root: workspace.root,
      handle,
      deadlineAt,
      finalizationReserveMs: FINALIZATION_RESERVE_MS,
      signal: abort.signal,
      sourceStore: workspace.sourceStore,
      budget,
      runtime: options.runtime,
      startedAt,
      inputSha256: workspace.inputSha256,
      classification: options.classification,
      researchModel,
      compilerModel,
      auditorModel,
      finalizerProvider,
      registerExcerptAllowance: gateway.registerExcerptAllowance,
      researchCheckpointConfig: checkpointConfigs.research,
      dossierCheckpointConfig: checkpointConfigs.dossier,
      onLeadStarted: async (sessionId) => {
        process.stderr.write(`Run ${runId}: lead session ${sessionId} is visible${options.watch ? " in the attached TUI" : ` with npm run attach -- ${runId}`}.\n`);
        if (options.watch && handle) watchProcess = attachTui(handle, password, sessionId);
      },
      onProgress: (message) => { if (!options.watch) process.stderr.write(`Run ${runId}: ${message}\n`); },
    });
    const integrity = await workspace.sourceStore.verify();
    if (!integrity.valid) throw new Error(`Source integrity failed for ${integrity.invalidSourceRefs.join(", ")}.`);
    const resultPath = join(workspace.root, "result.json");
    const reportPath = join(workspace.root, "report.pdf");
    reportTemporaryPath = `${reportPath}.tmp`;
    assertPublishableResult(output.result);
    await rm(reportTemporaryPath, { force: true });
    await atomicWrite(reportTemporaryPath, await renderInvestigationReport(output.result));
    await verifyInvestigationReport(await readFile(reportTemporaryPath));
    await runtime.stop(handle);
    handle = undefined;
    await publishFinalizationProvenance(workspace.root);
    if (!options.keepDebug) await removeRunDiagnostics(workspace.root);
    await rename(reportTemporaryPath, reportPath);
    reportTemporaryPath = undefined;
    await atomicWrite(resultPath, `${JSON.stringify(output.result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ runId, result: resultPath, report: reportPath, sources: join(workspace.root, "sources") }, null, 2)}\n`);
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error("Unknown headless investigation failure.");
    if (workspace) {
      await mkdir(join(workspace.root, "diagnostics"), { recursive: true });
      await sealRunFailure(workspace.root, {
        runId,
        code: abort.signal.aborted ? "CANCELLED_OR_TIMED_OUT" : "INVESTIGATION_FAILED",
        message: error.message,
        phase: handle ? "INVESTIGATION" : "STARTUP",
        cancelled: abort.signal.aborted,
        diagnostics: { ...(handle?.kind === "E2B" ? { sandboxId: handle.id } : {}), ...(handle?.kind === "LOCAL" ? { sessionId: handle.id } : {}) },
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
