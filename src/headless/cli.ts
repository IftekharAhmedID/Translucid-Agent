import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type ChildProcess } from "node:child_process";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { toolNames } from "../providers/contracts.ts";
import { buildCapabilityRegistry } from "../core/capabilities.ts";
import { ProviderExecutor } from "../providers/executor.ts";
import { E2BRuntime } from "../runtime/e2b.ts";
import { getPinnedLocalManifestHash, LocalDockerRuntime } from "../runtime/local-docker.ts";
import type { InvestigatorRuntime, RunHandle } from "../runtime/types.ts";
import { headlessBudgetCeilings, MemoryRunBudget, unboundedBudgetCeilings } from "./budget.ts";
import { parseInvestigationArguments } from "./cli-options.ts";
import { classifyInvestigationFailure, HeadlessInvestigationController } from "./controller.ts";
import { createHeadlessFixtureCompletion } from "./fixture-model.ts";
import { createHeadlessGateway } from "./gateway.ts";
import { createFileProviderBackend, summarizeProviderIntervals, type ProviderActivityEvent } from "./provider-store.ts";
import { leanReportResultSchema, ReportStore } from "./report-store.ts";
import { ResearchStateStore, researchSnapshotSha256, verifyResearchSnapshot, writeResearchSnapshot } from "./research-state.ts";
import { renderAuditReport, renderRecruiterReport, verifyInvestigationReport } from "./report.ts";
import { createRunWorkspace, removeRunDiagnostics, sealRunFailure, type RunWorkspace } from "./run-workspace.ts";
import { attachOpenCodeTui } from "./visible-tui.ts";
import { resolveResearchModel } from "./model-registry.ts";
import { preflightResearchModel } from "../gateway/model-proxy.ts";
import { RUN_TIMEOUT_MS, researchDeadlineAt } from "./deadlines.ts";
import { RunTimeline } from "./run-timeline.ts";
import { evaluateQualification, loadDiegoFactGroupFixture, readEvaluationSources, type QualificationEvaluation } from "./qualification-evaluator.ts";

async function atomicWrite(path: string, bytes: Uint8Array | string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, path);
}

function integerEnvironment(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function providerEnvironment(mode: "fixture" | "live", qualification: boolean): Record<string, string | undefined> {
  return qualification
    ? { ...process.env, PROVIDER_MODE: mode, QUALIFICATION_MODE: "unbounded" }
    : { ...process.env, PROVIDER_MODE: mode, QUALIFICATION_MODE: undefined, PROVIDER_BUDGET_USD: "10", GITHUB_CLONE_CEILING: "3", SOCIAL_PROFILE_CEILING: "1" };
}

function agentToolAllowlist(): Map<string, Set<string>> {
  return new Map([
    ["lead-researcher", new Set([...toolNames, "source.inventory", "source.excerpts", "investigation.plan.set", "investigation.target.add", "investigation.synthesis.begin", "investigation.finding.upsert", "investigation.progress.get", "investigation.summary.set", "investigation.commit"])],
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
  const runDeadline = options.qualification ? undefined : new Date(Date.now() + RUN_TIMEOUT_MS);
  const researchCutoff = runDeadline ? new Date(researchDeadlineAt(runDeadline.getTime())) : undefined;
  let workspace: RunWorkspace | undefined;
  let runtime: InvestigatorRuntime | undefined;
  let handle: RunHandle | undefined;
  let gateway: ReturnType<typeof createHeadlessGateway> | undefined;
  let watchProcess: ChildProcess | undefined;
  let attachPath: string | undefined;
  let reportTemporaryPath: string | undefined;
  let auditTemporaryPath: string | undefined;
  let timeline: RunTimeline | undefined;
  let preflightPath: string | undefined;
  let qualificationEvaluation: QualificationEvaluation | undefined;
  const abort = new AbortController();
  const abortHandler = () => abort.abort(new DOMException("Investigation cancelled by signal.", "AbortError"));
  process.once("SIGINT", abortHandler);
  process.once("SIGTERM", abortHandler);
  const deadline = options.qualification
    ? undefined
    : setTimeout(() => abort.abort(new DOMException("Investigation deadline reached.", "TimeoutError")), RUN_TIMEOUT_MS);

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
    timeline = new RunTimeline(join(workspace.root, "provenance", "run-timeline.jsonl"));
    await timeline.start();
    const expectedManifestHash = await getPinnedLocalManifestHash();
    const modelSpec = resolveResearchModel(process.env.RESEARCH_MODEL, process.env.RESEARCH_REASONING_VARIANT);
    const researchModel = modelSpec.id;
    const environment = providerEnvironment(options.providerMode, options.qualification);
    const capabilities = buildCapabilityRegistry(environment);
    await atomicWrite(join(workspace.root, "provenance", "capability-preflight.json"), `${JSON.stringify({ schemaVersion: 1, providerMode: options.providerMode, required: ["WEB_SEARCH", "GITHUB"], registry: capabilities }, null, 2)}\n`);
    await timeline.record({ kind: "capability.preflight.completed", status: "OK" });
    if (options.qualification && options.providerMode === "live") {
      if (researchModel !== "deepseek-v4-pro" || modelSpec.protocol !== "CHAT_COMPLETIONS" || modelSpec.variant !== "medium" || modelSpec.reasoningEffort !== "medium" || process.env.RESEARCH_OPENCODE_PROVIDER === "ZEN") {
        throw new Error("Qualification requires deepseek-v4-pro Chat Completions on the GO route with medium reasoning.");
      }
      for (const capability of ["WEB_SEARCH", "GITHUB"] as const) if (capabilities[capability].state !== "READY") throw new Error(`Qualification capability preflight failed: ${capability} is ${capabilities[capability].state}.`);
      preflightPath = join(workspace.root, "provenance", "model-preflight.json");
      await timeline.record({ kind: "model.preflight.started", model: researchModel, provider: "GO" });
      const preflight = await preflightResearchModel({ family: "GO", model: researchModel, apiKey: process.env.OPENCODE_API_KEY });
      await atomicWrite(preflightPath, `${JSON.stringify(preflight, null, 2)}\n`);
      await timeline.record({ kind: "model.preflight.completed", model: researchModel, provider: "GO", status: "OK" });
    }
    const budget = new MemoryRunBudget(options.qualification ? unboundedBudgetCeilings() : headlessBudgetCeilings(), { onChange: () => undefined });
    const researchState = await ResearchStateStore.open(workspace.root, workspace.sourceStore);
    const reportStore = await ReportStore.open(workspace.root, {
      runId,
      inputSha256: workspace.inputSha256,
      startedAt,
      runtime: options.runtime,
      model: researchModel,
      sourceStore: workspace.sourceStore,
      researchState,
    });
    const activity = { lastProgressAt: Date.now(), modelStartedAt: undefined as number | undefined };
    const providerIntervals: ProviderActivityEvent[] = [];
    let leadSessionId = "";
    const persistSnapshot = async () => {
      const integrity = await workspace!.sourceStore.verify();
      if (!integrity.valid) {
        const error = new Error(`Source integrity failed before research snapshot: ${integrity.invalidSourceRefs.join(", ")}.`);
        error.name = "RESEARCH_SOURCE_INTEGRITY_FAILED";
        throw error;
      }
      let sha256: string;
      try {
        sha256 = await writeResearchSnapshot(workspace!.root, { runtime: options.runtime, researchModel, leadSessionId }, workspace!.sourceStore);
      } catch (error) {
        const wrapped = new Error(`Research snapshot could not be written: ${error instanceof Error ? error.message : String(error)}`);
        wrapped.name = "RESEARCH_SNAPSHOT_WRITE_FAILED";
        throw wrapped;
      }
      try {
        await verifyResearchSnapshot(workspace!.root);
        const verifiedSha256 = await researchSnapshotSha256(workspace!.root);
        if (verifiedSha256 !== sha256) throw new Error("Snapshot digest changed during immediate verification.");
      } catch (error) {
        const wrapped = new Error(`Research snapshot verification failed: ${error instanceof Error ? error.message : String(error)}`);
        wrapped.name = "RESEARCH_SNAPSHOT_VERIFY_FAILED";
        throw wrapped;
      }
      return sha256;
    };
    const providerExecutor = new ProviderExecutor(environment, createFileProviderBackend({
      sourceStore: workspace.sourceStore,
      budget,
      ...(researchCutoff ? { deadlineAt: researchCutoff.getTime() } : {}),
      onProviderActivity: (event) => {
        providerIntervals.push(event);
        void timeline?.record({
          kind: `provider.${event.kind}`,
          provider: event.provider,
          name: event.providerRoute,
          semanticTool: event.semanticTool,
          ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
          ...(event.startedAt ? { providerStartedAt: event.startedAt } : {}),
          ...(event.endedAt ? { providerEndedAt: event.endedAt } : {}),
          ...(event.outcome ? { providerOutcome: event.outcome } : {}),
          ...(event.startedMono !== undefined ? { providerStartedMono: event.startedMono } : {}),
          ...(event.endedMono !== undefined ? { providerEndedMono: event.endedMono } : {}),
          ...(event.batchId ? { batchId: event.batchId } : {}),
          ...(event.batchIndex !== undefined ? { batchIndex: event.batchIndex } : {}),
          ...(event.elapsedMs !== undefined ? { elapsedProviderMs: event.elapsedMs } : {}),
        });
      },
    }));
    const researchProvider = process.env.RESEARCH_OPENCODE_PROVIDER === "ZEN" ? "ZEN" : "GO";
    const fixture = createHeadlessFixtureCompletion();
    gateway = createHeadlessGateway({
      runId,
      ...(runDeadline ? { deadlineAt: runDeadline.getTime() } : {}),
      ...(researchCutoff ? { researchDeadlineAt: researchCutoff.getTime() } : {}),
      allowedTools: new Set([...toolNames, "source.inventory", "source.excerpts", "investigation.plan.set", "investigation.target.add", "investigation.synthesis.begin", "investigation.finding.upsert", "investigation.progress.get", "investigation.summary.set", "investigation.commit"]),
      allowedModels: new Set([researchModel]),
      agentTools: agentToolAllowlist(),
      reportStore,
      researchState,
      executor: providerExecutor,
      sourceStore: workspace.sourceStore,
      budget,
      providerMode: options.providerMode,
      researchUpstreamFamily: researchProvider,
      expectedReasoningEffort: modelSpec.reasoningEffort,
      fixtureCompletion: (body, agent) => fixture(body, agent),
      onModelRequest: ({ reasoningEffort }) => {
        void timeline?.record({ kind: "model.reasoning-effort.observed", model: researchModel, status: reasoningEffort === modelSpec.reasoningEffort ? "OK" : "ERROR", detail: reasoningEffort ?? "missing" });
      },
      onActivity: (event) => {
        activity.lastProgressAt = event.at;
        if (event.kind === "model-start") activity.modelStartedAt = event.at;
        if (event.kind === "model-end") activity.modelStartedAt = undefined;
        void timeline?.record({ kind: `gateway.${event.kind}`, name: event.name });
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
      ...(runDeadline ? { deadlineAt: runDeadline.toISOString() } : {}),
    });
    if (handle.kind === "LOCAL") {
      const attachDirectory = resolve(".debug", "headless");
      await mkdir(attachDirectory, { recursive: true, mode: 0o700 });
      attachPath = join(attachDirectory, `${runId}.json`);
      await writeFile(attachPath, JSON.stringify({ openCodeUrl: handle.openCodeUrl, password, title: "Headless lead research" }), { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
    const controller = new HeadlessInvestigationController();
    await timeline?.record({ kind: "research.started", status: "OK" });
    const output = await controller.run({
      root: workspace.root,
      handle,
      ...(runDeadline ? { deadlineAt: runDeadline, researchDeadlineAt: researchCutoff } : {}),
      signal: abort.signal,
      runtime: options.runtime,
      researchModel,
      researchVariant: modelSpec.variant,
      compactContext: process.env.RESEARCH_CONTEXT_MODE === "compact",
      reportStore,
      researchState,
      sourceStore: workspace.sourceStore,
      activity,
      persistResearchSnapshot: persistSnapshot,
      bindResearchSnapshot: (sha256) => reportStore.bindResearchSnapshot(sha256).then(() => undefined),
      onLeadStarted: async (sessionId) => {
        leadSessionId = sessionId;
        gateway?.setLeadSession(sessionId);
        await timeline?.record({ kind: "lead.session.started", name: sessionId });
        process.stderr.write(`Run ${runId}: lead session ${sessionId} is visible${options.watch ? " in the attached TUI" : ` with npm run attach -- ${runId}`}.\n`);
        if (options.watch && handle) watchProcess = attachOpenCodeTui(handle, password, sessionId);
      },
      onLeadSessionMetadata: async (stage, metadata) => {
        await atomicWrite(join(workspace!.root, ".work", "lead-session.json"), `${JSON.stringify({ schemaVersion: 1, stage, ...metadata }, null, 2)}\n`);
        await timeline?.record({ kind: `lead.session.${stage}`, status: "OK" });
      },
      onProgress: (message) => { if (!options.watch) process.stderr.write(`Run ${runId}: ${message}\n`); },
    });
    await timeline?.record({ kind: "research.frozen", status: "OK" });
    const integrity = await workspace.sourceStore.verify();
    if (!integrity.valid) {
      const error = new Error(`Source integrity failed for ${integrity.invalidSourceRefs.join(", ")}.`);
      error.name = "RESEARCH_SOURCE_INTEGRITY_FAILED";
      throw error;
    }
    if (output.result.schemaVersion !== 4) throw new Error("Only result-v4 may be published by a new v3 run.");
    const actualLeadModel = output.leadSession.model && typeof output.leadSession.model === "object" ? output.leadSession.model as Record<string, unknown> : {};
    if (options.qualification && (output.leadSession.agent !== "lead-researcher" || actualLeadModel.id !== "deepseek-v4-pro" || actualLeadModel.providerID !== "translucid" || actualLeadModel.variant !== "medium")) throw new Error("Lead session metadata does not prove the required DeepSeek V4 Pro medium lead configuration.");
    await verifyResearchSnapshot(workspace.root);
    const actualSnapshotSha256 = await researchSnapshotSha256(workspace.root);
    const draft = await reportStore.progress();
    if (draft.schemaVersion !== 2 || draft.researchSnapshotSha256 !== actualSnapshotSha256 || output.result.researchSnapshotSha256 !== actualSnapshotSha256) {
      const error = new Error("Bound research snapshot SHA-256 does not match the verified snapshot.");
      error.name = "RESEARCH_SNAPSHOT_VERIFY_FAILED";
      throw error;
    }
    const resultPath = join(workspace.root, "result.json");
    const reportPath = join(workspace.root, "report.pdf");
    const auditPath = join(workspace.root, "audit.pdf");
    reportTemporaryPath = `${reportPath}.tmp`;
    auditTemporaryPath = `${auditPath}.tmp`;
    await rm(reportTemporaryPath, { force: true });
    await rm(auditTemporaryPath, { force: true });
    const reportBytes = await renderRecruiterReport(output.result);
    const auditBytes = await renderAuditReport(output.result);
    await timeline?.record({ kind: "publication.started", status: "OK" });
    await atomicWrite(reportTemporaryPath, reportBytes);
    await atomicWrite(auditTemporaryPath, auditBytes);
    const reportVerification = await verifyInvestigationReport(reportBytes);
    const auditVerification = await verifyInvestigationReport(auditBytes);
    await timeline?.record({ kind: "publication.report.pdf.verified", status: "OK" });
    await timeline?.record({ kind: "publication.audit.pdf.verified", status: "OK" });
    await runtime.stop(handle);
    handle = undefined;
    await mkdir(join(workspace.root, "provenance"), { recursive: true });
    const progress = await reportStore.progress();
    const telemetry = gateway?.telemetry() ?? { semanticAgentCount: 0, modelRequests: 0, providerCallsDuringSynthesis: 0, nonLeadSemanticModelRequests: 0, reportWriterModelRequests: 0, observedReasoningEfforts: [], modelTiming: {}, providerTiming: {} };
    if (telemetry.semanticAgentCount !== 1 || telemetry.nonLeadSemanticModelRequests !== 0 || telemetry.reportWriterModelRequests !== 0) {
      throw new Error("Semantic provenance invariant failed: expected exactly one lead agent and no non-lead or report-writer model requests.");
    }
    if (options.qualification && (telemetry.observedReasoningEfforts.length !== 1 || telemetry.observedReasoningEfforts[0] !== "medium")) {
      throw new Error(`Qualification reasoning telemetry failed: expected one sanitized medium request, observed ${telemetry.observedReasoningEfforts.join(", ") || "none"}.`);
    }
    const citedSourceRefs = [...new Set(output.result.findings.flatMap(({ sources }) => sources.map(({ sourceRef }) => sourceRef)))].sort();
    const capturedSources = await workspace.sourceStore.list();
    const eligibleSources = capturedSources.filter(({ kind, sourceUrl }) => kind !== "SEARCH_DISCOVERY" && Boolean(sourceUrl));
    const citedRefSet = new Set(citedSourceRefs);
    const eligibleUrls = [...new Set(eligibleSources.flatMap(({ sourceUrl }) => sourceUrl ? [sourceUrl] : []))].sort();
    const citedUrls = [...new Set(eligibleSources.filter(({ ref }) => citedRefSet.has(ref)).flatMap(({ sourceUrl }) => sourceUrl ? [sourceUrl] : []))].sort();
    const uncitedEligibleUrls = eligibleUrls.filter((url) => !citedUrls.includes(url));
    const providerStats = await workspace.sourceStore.requestStats();
    if (providerStats.invalidRows) throw new Error(`Provider request ledger contains ${providerStats.invalidRows} invalid row(s).`);
    if (options.qualification && options.providerMode === "live") {
      const fixture = await loadDiegoFactGroupFixture();
      const evaluationSources = await readEvaluationSources(workspace.root, capturedSources);
      qualificationEvaluation = evaluateQualification({ fixture, sources: evaluationSources, citedSourceRefs: citedSourceRefs, result: output.result });
      await timeline?.record({ kind: "qualification.evaluated", status: qualificationEvaluation.qualification });
      await atomicWrite(join(workspace.root, "provenance", "qualification.json"), `${JSON.stringify({ schemaVersion: 1, ...qualificationEvaluation }, null, 2)}\n`);
    }
    await timeline?.record({ kind: "publication.provenance.written", status: "OK" });
    await timeline?.flush();
    await atomicWrite(join(workspace.root, "provenance", "report.json"), `${JSON.stringify({
      schemaVersion: 1,
      runId,
      leadSessionId: output.leadSessionId,
      researchAgent: "lead-researcher",
      researchModel,
      researchSnapshotSha256: actualSnapshotSha256,
      inputSha256: workspace.inputSha256,
      reportDraftRevision: progress.revision,
      semanticAgentCount: telemetry.semanticAgentCount,
      modelRequests: telemetry.modelRequests,
      nonLeadSemanticModelRequests: telemetry.nonLeadSemanticModelRequests,
      reportWriterModelRequests: telemetry.reportWriterModelRequests,
      providerCallsDuringSynthesis: telemetry.providerCallsDuringSynthesis,
      modelTiming: telemetry.modelTiming,
      providerTiming: telemetry.providerTiming,
      providerIntervals: summarizeProviderIntervals(providerIntervals),
      timing: timeline?.timingSummary({
        modelElapsedMs: Object.values(telemetry.modelTiming).reduce((sum, value) => sum + value.totalElapsedMs, 0),
        providerElapsedMs: summarizeProviderIntervals(providerIntervals).unionElapsedMs,
      }) ?? null,
      qualification: qualificationEvaluation ?? null,
      qualificationPath: qualificationEvaluation ? "provenance/qualification.json" : null,
      providerStats,
      leadSession: output.leadSession,
      modelConfig: { protocol: modelSpec.protocol, requestedVariant: modelSpec.variant, variant: modelSpec.variant, reasoningEffort: modelSpec.reasoningEffort, effectiveReasoningEffort: modelSpec.effectiveReasoningEffort, upstreamFamily: researchProvider, observedReasoningEfforts: telemetry.observedReasoningEfforts },
      modelRoutePreflight: preflightPath ? "provenance/model-preflight.json" : null,
      capabilityPreflight: "provenance/capability-preflight.json",
      timeline: "provenance/run-timeline.jsonl",
      sourceRefs: citedSourceRefs,
      coverage: { eligibleUrlCount: eligibleUrls.length, citedUrlCount: citedUrls.length, uncitedEligibleUrls },
      artifacts: {
        report: { path: "report.pdf", sha256: createHash("sha256").update(reportBytes).digest("hex"), pageCount: reportVerification.pageCount, verified: true },
        audit: { path: "audit.pdf", sha256: createHash("sha256").update(auditBytes).digest("hex"), pageCount: auditVerification.pageCount, verified: true },
      },
    }, null, 2)}\n`);
    await rename(auditTemporaryPath, auditPath);
    auditTemporaryPath = undefined;
    await timeline?.record({ kind: "publication.audit.pdf.written", status: "OK" });
    await rename(reportTemporaryPath, reportPath);
    reportTemporaryPath = undefined;
    await timeline?.record({ kind: "publication.report.pdf.written", status: "OK" });
    await reportStore.markPublished();
    if (!options.keepDebug) await removeRunDiagnostics(workspace.root);
    await atomicWrite(resultPath, `${JSON.stringify(output.result, null, 2)}\n`);
    const writtenResult = leanReportResultSchema.parse(JSON.parse(await readFile(resultPath, "utf8")));
    if (writtenResult.schemaVersion !== 4 || writtenResult.researchSnapshotSha256 !== actualSnapshotSha256) throw new Error("Published result failed final digest validation.");
    await timeline?.record({ kind: "publication.result.written", status: "OK" });
    await timeline?.flush();
    if (timeline?.publicationOrder().at(-1) !== "publication.result.written") throw new Error("Published result failed timeline ordering validation.");
    if (qualificationEvaluation && qualificationEvaluation.qualification !== "PASS") {
      const error = new Error(`Diego qualification ${qualificationEvaluation.qualification}; preserved report, PDFs, provenance, and result for review.`);
      error.name = qualificationEvaluation.qualification === "FAIL" ? "QUALIFICATION_FAILED" : "QUALIFICATION_REQUIRES_HUMAN_REVIEW";
      throw error;
    }
    process.stdout.write(`${JSON.stringify({ runId, result: resultPath, report: reportPath, audit: auditPath, sources: join(workspace.root, "sources") }, null, 2)}\n`);
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error("Unknown headless investigation failure.");
    if (workspace) {
      await timeline?.record({ kind: "run.failed", status: "ERROR", detail: error.message });
      await timeline?.flush();
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
          ...(timeline ? { timelinePath: "provenance/run-timeline.jsonl", ...timeline.summary() } : {}),
          ...(preflightPath ? { preflightPath: "provenance/model-preflight.json" } : {}),
          ...(workspace ? { leadSessionPath: ".work/lead-session.json" } : {}),
        },
      }).catch(() => undefined);
    }
    process.stderr.write(`Run ${runId} failed: ${error.message}\n`);
    process.exitCode = 1;
    if (runtime && handle) await runtime.stop(handle).catch(() => undefined);
  } finally {
    if (deadline) clearTimeout(deadline);
    process.removeListener("SIGINT", abortHandler);
    process.removeListener("SIGTERM", abortHandler);
    if (attachPath) await rm(attachPath, { force: true });
    if (watchProcess && !watchProcess.killed) watchProcess.kill("SIGTERM");
    gateway?.cancel();
    if (gateway) await closeServer(gateway.server);
  }
}

await main();
