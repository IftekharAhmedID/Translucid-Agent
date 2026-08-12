import { randomBytes, randomUUID } from "node:crypto";
import { open, readFile, readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

import { E2BRuntime } from "../runtime/e2b.ts";
import { PAID_GO_MODEL_IDS } from "../core/model-catalog.ts";
import { loadModelRequestTimeouts } from "../core/config.ts";
import { getPinnedLocalManifestHash, getPinnedResearchManifestHash, LocalDockerRuntime } from "../runtime/local-docker.ts";
import type { InvestigatorRuntime, RunHandle } from "../runtime/types.ts";
import { currentCheckpointConfigs } from "./checkpoint-config.ts";
import {
  loadValidDossierCheckpoint,
  loadValidPacketDossierCheckpoint,
  archivePriorFailure,
  openPersistentRunBudget,
  readHandoffManifest,
  validateResearchCheckpoint,
} from "./checkpoint.ts";
import { parseFinalizeArguments } from "./finalize-options.ts";
import { runFinalizationPipeline } from "./finalization-controller.ts";
import { createHeadlessFixtureCompletion } from "./fixture-model.ts";
import { createHeadlessGateway } from "./gateway.ts";
import { renderInvestigationReport } from "./report.ts";
import { openRunWorkspace, removeRunDiagnostics, sealRunFailure, type ExistingRunWorkspace } from "./run-workspace.ts";

const RUN_TIMEOUT_MS = 60 * 60_000;
const ceilings = { modelUsd: 5, providerUsd: 10, externalNetworkCalls: 300, repositoryClones: 3, socialProfiles: 1 } as const;

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

function upstream(provider: "ZEN" | "GO"): string {
  return provider === "GO" ? "https://opencode.ai/zen/go/v1/chat/completions" : "https://opencode.ai/zen/v1/chat/completions";
}

async function listen(server: ReturnType<typeof createHeadlessGateway>["server"], port: number): Promise<number> {
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", done);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Finalization gateway did not bind a TCP port.");
  return address.port;
}

async function closeServer(server: ReturnType<typeof createHeadlessGateway>["server"]): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((done) => server.close(() => done()));
}

async function researchMemos(root: string): Promise<string> {
  const directory = join(root, ".work", "memos");
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0) throw new Error("Research checkpoint contains no completed memos.");
  return (await Promise.all(files.map((file) => readFile(join(directory, file), "utf8")))).join("\n\n");
}

async function runtimeFor(workspace: ExistingRunWorkspace): Promise<InvestigatorRuntime> {
  if (workspace.runtime === "LOCAL") return new LocalDockerRuntime();
  if (!process.env.E2B_API_KEY || !process.env.E2B_TEMPLATE_ID) throw new Error("E2B finalization requires E2B_API_KEY and E2B_TEMPLATE_ID.");
  return new E2BRuntime({ apiKey: process.env.E2B_API_KEY, templateId: process.env.E2B_TEMPLATE_ID });
}

async function main(): Promise<void> {
  const options = parseFinalizeArguments(process.argv.slice(2));
  const resultPath = join(options.runDirectory, "result.json");
  if (await exists(resultPath)) throw new Error("A successful result.json already exists; finalization will not overwrite it.");

  const workspace = await openRunWorkspace(options.runDirectory);
  const archivedFailure = Boolean(await archivePriorFailure(workspace.root));
  const existingManifest = await readHandoffManifest(workspace.root);
  if (existingManifest.research.config.runtime !== workspace.runtime) throw new Error("Research checkpoint runtime differs from the immutable input manifest.");
  const expectedManifestHash = await getPinnedLocalManifestHash();
  const researchManifestHash = await getPinnedResearchManifestHash();
  const compilerModel = process.env.FINALIZER_MODEL ?? "mimo-v2.5-pro";
  const checkpointConfigs = await currentCheckpointConfigs({
    repositoryRoot: process.cwd(),
    runtime: workspace.runtime,
    providerMode: existingManifest.research.config.providerMode,
    researchModel: existingManifest.research.config.researchModel,
    compilerModel,
    runtimeManifestHash: researchManifestHash,
  });
  const manifest = await validateResearchCheckpoint(workspace.root, checkpointConfigs.research);
  const reusableDossier = await loadValidDossierCheckpoint(workspace.root, manifest, checkpointConfigs.dossier);
  const reusablePacketDossier = await loadValidPacketDossierCheckpoint(workspace.root, manifest, checkpointConfigs.dossier);
  const budget = await openPersistentRunBudget(workspace.root, ceilings, manifest.research.budget);
  const memos = await researchMemos(workspace.root);

  const finalizerProvider = process.env.FINALIZER_OPENCODE_PROVIDER === "ZEN" ? "ZEN" : "GO";
  const fixture = createHeadlessFixtureCompletion();
  const deadlineAt = new Date(Date.now() + RUN_TIMEOUT_MS);
  const gateway = createHeadlessGateway({
    runId: workspace.runId,
    deadlineAt: deadlineAt.getTime(),
    allowedTools: new Set(["source.excerpts"]),
    allowedModels: new Set([compilerModel, ...PAID_GO_MODEL_IDS]),
    agentTools: new Map([
      ["evidence-compiler", new Set(["source.excerpts"])],
      ["evidence-auditor", new Set(["source.excerpts"])],
    ]),
    sourceStore: workspace.sourceStore,
    budget,
    providerMode: existingManifest.research.config.providerMode,
    finalizerUpstreamUrl: upstream(finalizerProvider),
    finalizerProvider,
    finalizerModel: compilerModel,
    modelRequestTimeouts: loadModelRequestTimeouts(process.env),
    fixtureCompletion: (body, agent) => fixture(body, agent),
  });
  let runtime: InvestigatorRuntime | undefined;
  let handle: RunHandle | undefined;
  const abort = new AbortController();
  const abortHandler = () => abort.abort(new DOMException("Finalization cancelled by signal.", "AbortError"));
  process.once("SIGINT", abortHandler);
  process.once("SIGTERM", abortHandler);
  const deadline = setTimeout(() => abort.abort(new DOMException("Finalization deadline reached.", "TimeoutError")), RUN_TIMEOUT_MS);
  try {
    const configuredPort = Number(process.env.HEADLESS_GATEWAY_PORT ?? 3001);
    const gatewayPort = await listen(gateway.server, workspace.runtime === "LOCAL" ? 0 : Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 3001);
    const localGatewayUrl = `http://127.0.0.1:${gatewayPort}`;
    const gatewayUrl = workspace.runtime === "E2B" ? process.env.E2B_GATEWAY_PUBLIC_URL : localGatewayUrl;
    if (!gatewayUrl || (workspace.runtime === "E2B" && !gatewayUrl.startsWith("https://"))) {
      throw new Error("E2B finalization requires an HTTPS E2B_GATEWAY_PUBLIC_URL routed to this gateway.");
    }
    runtime = await runtimeFor(workspace);
    const password = randomBytes(24).toString("base64url");
    handle = await runtime.start({
      investigationId: workspace.runId,
      runId: workspace.runId,
      caseDirectory: workspace.root,
      gatewayUrl,
      caseToken: gateway.token,
      openCodePassword: password,
      expectedManifestHash,
      timeoutMs: RUN_TIMEOUT_MS,
      mode: "headless",
      deadlineAt: deadlineAt.toISOString(),
    });
    const result = await runFinalizationPipeline({
      runId: workspace.runId,
      root: workspace.root,
      handle,
      signal: abort.signal,
      sourceStore: workspace.sourceStore,
      budget,
      runtime: workspace.runtime,
      startedAt: workspace.startedAt,
      inputSha256: workspace.inputSha256,
      classification: workspace.classification,
      researchModel: manifest.research.config.researchModel,
      compilerModel,
      auditorModel: compilerModel,
      finalizerProvider,
      deadlineAt: deadlineAt.getTime(),
      registerExcerptAllowance: gateway.registerExcerptAllowance,
      researchMemos: memos,
      warnings: manifest.research.warnings,
      dossierCheckpointConfig: checkpointConfigs.dossier,
      ...(reusableDossier ? { reusableDossier } : {}),
      ...(reusablePacketDossier ? { reusablePacketDossier } : {}),
      onProgress: (message) => process.stderr.write(`Run ${workspace.runId}: ${message}\n`),
    });
    const integrity = await workspace.sourceStore.verify();
    if (!integrity.valid) throw new Error(`Source integrity failed for ${integrity.invalidSourceRefs.join(", ")}.`);
    await atomicWrite(join(workspace.root, "report.pdf"), await renderInvestigationReport(result));
    await atomicWrite(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    await runtime.stop(handle);
    handle = undefined;
    if (!options.keepDebug) await removeRunDiagnostics(workspace.root);
    process.stdout.write(`${JSON.stringify({ runId: workspace.runId, result: resultPath, report: join(workspace.root, "report.pdf"), reusedDossier: Boolean(reusableDossier || reusablePacketDossier) }, null, 2)}\n`);
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error("Unknown finalization failure.");
    if (archivedFailure || !await exists(join(workspace.root, "failure.json"))) {
      await sealRunFailure(workspace.root, {
        runId: workspace.runId,
        code: abort.signal.aborted ? "CANCELLED_OR_TIMED_OUT" : "FINALIZATION_FAILED",
        message: error.message,
        phase: "FINALIZATION",
        cancelled: abort.signal.aborted,
        diagnostics: handle ? { sessionId: handle.id } : {},
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGINT", abortHandler);
    process.removeListener("SIGTERM", abortHandler);
    if (runtime && handle) await runtime.stop(handle).catch(() => undefined);
    gateway.cancel();
    await closeServer(gateway.server);
  }
}

await main().catch((error) => {
  process.stderr.write(`Finalization failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
