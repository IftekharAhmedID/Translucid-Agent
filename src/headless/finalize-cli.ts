import { randomBytes, randomUUID } from "node:crypto";
import { type ChildProcess } from "node:child_process";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { E2BRuntime } from "../runtime/e2b.ts";
import { getPinnedLocalManifestHash, LocalDockerRuntime } from "../runtime/local-docker.ts";
import type { InvestigatorRuntime, RunHandle } from "../runtime/types.ts";
import { headlessBudgetCeilings, MemoryRunBudget } from "./budget.ts";
import { runPublishingRecovery } from "./controller.ts";
import { parseFinalizeArguments } from "./finalize-options.ts";
import { createHeadlessFixtureCompletion } from "./fixture-model.ts";
import { createHeadlessGateway } from "./gateway.ts";
import { verifyResearchSnapshot } from "./recovery.ts";
import { renderLeanReport, verifyInvestigationReport } from "./report.ts";
import { reportToolNames, ReportStore } from "./report-store.ts";
import { openRunWorkspace, removeRunDiagnostics, sealRunFailure, type ExistingRunWorkspace } from "./run-workspace.ts";
import { attachOpenCodeTui } from "./visible-tui.ts";

const RUN_TIMEOUT_MS = 60 * 60_000;

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function atomicWrite(path: string, bytes: Uint8Array | string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function listen(server: ReturnType<typeof createHeadlessGateway>["server"], port: number): Promise<number> {
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", done);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Publishing gateway did not bind a TCP port.");
  return address.port;
}

async function closeServer(server: ReturnType<typeof createHeadlessGateway>["server"]): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((done) => server.close(() => done()));
}

async function runtimeFor(workspace: ExistingRunWorkspace): Promise<InvestigatorRuntime> {
  if (workspace.runtime === "LOCAL") return new LocalDockerRuntime();
  if (!process.env.E2B_API_KEY || !process.env.E2B_TEMPLATE_ID) throw new Error("E2B publishing requires E2B_API_KEY and E2B_TEMPLATE_ID.");
  return new E2BRuntime({ apiKey: process.env.E2B_API_KEY, templateId: process.env.E2B_TEMPLATE_ID });
}

async function archiveFailure(root: string): Promise<void> {
  const path = join(root, "failure.json");
  if (!await exists(path)) return;
  const directory = join(root, ".work", "failures");
  await mkdir(directory, { recursive: true });
  await rename(path, join(directory, `previous-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
}

async function main(): Promise<void> {
  const options = parseFinalizeArguments(process.argv.slice(2));
  const resultPath = join(options.runDirectory, "result.json");
  const reportPath = join(options.runDirectory, "report.pdf");
  const reportTemporaryPath = `${reportPath}.tmp`;
  if (await exists(resultPath)) throw new Error("A successful result.json already exists; publishing will not overwrite it.");

  const workspace = await openRunWorkspace(options.runDirectory);
  if (options.watch && workspace.runtime !== "LOCAL") throw new Error("--watch requires the local Docker runtime; E2B recovery has no TUI access.");
  const snapshot = await verifyResearchSnapshot(workspace.root);
  if (snapshot.runtime !== workspace.runtime) throw new Error("Research snapshot runtime differs from the immutable input manifest.");
  const integrity = await workspace.sourceStore.verify();
  if (!integrity.valid) throw new Error(`Source integrity failed for ${integrity.invalidSourceRefs.join(", ")}.`);
  await archiveFailure(workspace.root);
  const requestStatsBefore = await workspace.sourceStore.requestStats();
  const reportStore = await ReportStore.open(workspace.root, {
    runId: workspace.runId,
    inputSha256: workspace.inputSha256,
    startedAt: workspace.startedAt,
    runtime: workspace.runtime,
    model: snapshot.researchModel,
    sourceStore: workspace.sourceStore,
  });
  const budget = new MemoryRunBudget(headlessBudgetCeilings());
  const fixture = createHeadlessFixtureCompletion();
  const providerMode = process.env.PROVIDER_MODE === "fixture" ? "fixture" : "live";
  const researchProvider = process.env.RESEARCH_OPENCODE_PROVIDER === "ZEN" ? "ZEN" : "GO";
  const deadlineAt = Date.now() + RUN_TIMEOUT_MS;
  const gateway = createHeadlessGateway({
    runId: workspace.runId,
    deadlineAt,
    allowedTools: new Set(["source.excerpts", ...reportToolNames]),
    allowedModels: new Set([snapshot.researchModel]),
    agentTools: new Map([["lead-researcher", new Set(["source.excerpts", ...reportToolNames])]]),
    reportStore,
    sourceStore: workspace.sourceStore,
    budget,
    providerMode,
    researchUpstreamFamily: researchProvider,
    fixtureCompletion: (body, agent) => fixture(body, agent),
  });
  gateway.setPhase("PUBLISHING");
  let runtime: InvestigatorRuntime | undefined;
  let handle: RunHandle | undefined;
  let watchProcess: ChildProcess | undefined;
  let publisherManifestHash: string | undefined;
  const password = randomBytes(24).toString("base64url");
  const abort = new AbortController();
  const abortHandler = () => abort.abort(new DOMException("Publishing cancelled by signal.", "AbortError"));
  process.once("SIGINT", abortHandler);
  process.once("SIGTERM", abortHandler);
  const deadline = setTimeout(() => abort.abort(new DOMException("Publishing deadline reached.", "TimeoutError")), RUN_TIMEOUT_MS);
  try {
    const configuredPort = Number(process.env.HEADLESS_GATEWAY_PORT ?? 3001);
    const gatewayPort = await listen(gateway.server, workspace.runtime === "LOCAL" ? 0 : Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 3001);
    const localGatewayUrl = `http://127.0.0.1:${gatewayPort}`;
    const gatewayUrl = workspace.runtime === "E2B" ? process.env.E2B_GATEWAY_PUBLIC_URL : localGatewayUrl;
    if (!gatewayUrl || (workspace.runtime === "E2B" && !gatewayUrl.startsWith("https://"))) throw new Error("E2B publishing requires an HTTPS E2B_GATEWAY_PUBLIC_URL routed to this gateway.");
    runtime = await runtimeFor(workspace);
    handle = await runtime.start({
      investigationId: workspace.runId,
      runId: workspace.runId,
      caseDirectory: workspace.root,
      gatewayUrl,
      caseToken: gateway.token,
      openCodePassword: password,
      expectedManifestHash: await getPinnedLocalManifestHash(),
      timeoutMs: RUN_TIMEOUT_MS,
      mode: "headless",
      deadlineAt: new Date(deadlineAt).toISOString(),
      allowStaleCaseManifest: true,
    });
    publisherManifestHash = handle.manifestHash;
    const output = await runPublishingRecovery({
      handle,
      model: snapshot.researchModel,
      deadlineAt,
      signal: abort.signal,
      reportStore,
      onSessionStarted: (sessionId) => {
        if (options.watch && handle?.kind === "LOCAL") {
          process.stderr.write(`Publishing session ${sessionId} is visible in the attached TUI.\n`);
          watchProcess = attachOpenCodeTui(handle, password, sessionId);
        }
      },
    });
    const requestStatsAfter = await workspace.sourceStore.requestStats();
    if (JSON.stringify(requestStatsAfter) !== JSON.stringify(requestStatsBefore)) throw new Error("Publishing changed provider request statistics; research replay is forbidden.");
    await rm(reportTemporaryPath, { force: true });
    await atomicWrite(reportTemporaryPath, await renderLeanReport(output.result));
    await verifyInvestigationReport(await readFile(reportTemporaryPath));
    await runtime.stop(handle);
    handle = undefined;
    await mkdir(join(workspace.root, "provenance"), { recursive: true });
    const progress = await reportStore.progress();
    await atomicWrite(join(workspace.root, "provenance", "report.json"), `${JSON.stringify({
      schemaVersion: 1,
      runId: workspace.runId,
      inputSha256: workspace.inputSha256,
      researchSnapshot: snapshot,
      reportDraftRevision: progress.revision,
      providerRequestStatsBefore: requestStatsBefore,
      providerRequestStatsAfter: requestStatsAfter,
      publisherSessionId: output.sessionId,
      publisherManifestHash,
      sourceRefs: [...new Set(output.result.findings.flatMap(({ sources }) => sources.map(({ sourceRef }) => sourceRef)))].sort(),
    }, null, 2)}\n`);
    await rename(reportTemporaryPath, reportPath);
    await reportStore.markPublished();
    if (!options.keepDebug) await removeRunDiagnostics(workspace.root);
    await atomicWrite(resultPath, `${JSON.stringify(output.result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ runId: workspace.runId, result: resultPath, report: reportPath, researchReplayed: false, findings: output.result.findings.length }, null, 2)}\n`);
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error("Unknown publishing failure.");
    await sealRunFailure(workspace.root, {
      runId: workspace.runId,
      code: abort.signal.aborted ? "CANCELLED_OR_TIMED_OUT" : "PUBLISHING_FAILED",
      message: error.message,
      phase: "PUBLISHING",
      cancelled: abort.signal.aborted,
      diagnostics: handle ? { sessionId: handle.id } : {},
    }).catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGINT", abortHandler);
    process.removeListener("SIGTERM", abortHandler);
    if (runtime && handle) await runtime.stop(handle).catch(() => undefined);
    if (watchProcess && !watchProcess.killed) watchProcess.kill("SIGTERM");
    gateway.cancel();
    await closeServer(gateway.server);
    await rm(reportTemporaryPath, { force: true }).catch(() => undefined);
  }
}

await main().catch((error) => {
  process.stderr.write(`Publishing failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
