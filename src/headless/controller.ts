import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

import type { RunHandle } from "../runtime/types.ts";
import { createOpenCodeStructuredWriter, finalizeFrozenResearch } from "./finalization.ts";
import { researchPrompt } from "./prompt-contracts.ts";
import type { ResearchStateStore } from "./research-state.ts";
import type { LeanReportResult, ReportStore } from "./report-store.ts";
import type { FileSourceStore } from "./source-store.ts";

const directory = "/workspace/case";
const MODEL_STALL_MS = 5 * 60_000;
const PROGRESS_STALL_MS = 3 * 60_000;

export class InvestigationStallError extends Error {
  constructor(readonly phase: "RESEARCH" | "PUBLISHING", message: string, readonly code = "INVESTIGATION_STALLED") {
    super(message);
    this.name = "InvestigationStallError";
  }
}

export class ResearchDeadlineError extends Error {
  readonly code = "RESEARCH_DEADLINE";
  readonly phase = "RESEARCH" as const;

  constructor(message = "Research deadline reached; freezing the investigation.") {
    super(message);
    this.name = "ResearchDeadlineError";
  }
}

export class ResearchFreezeError extends Error {
  constructor(readonly code: "RESEARCH_STATE_REQUIRED" | "RESEARCH_STATE_NOT_READY", message: string, readonly originalFailure?: string) {
    super(originalFailure ? `${message} Original research termination: ${originalFailure.slice(0, 800)}` : message);
    this.name = "ResearchFreezeError";
  }
}

export function isRecoverableResearchTermination(error: unknown): boolean {
  return (error instanceof InvestigationStallError && error.phase === "RESEARCH") || error instanceof ResearchDeadlineError;
}

export function canPublishAfterResearchFailure(error: unknown, publicationReady: boolean): boolean {
  return (!error || isRecoverableResearchTermination(error)) && publicationReady;
}

export function describeSdkError(error: unknown): string {
  if (error instanceof Error) {
    const details = Object.fromEntries(Object.getOwnPropertyNames(error)
      .filter((name) => !new Set(["name", "message", "stack"]).has(name))
      .map((name) => [name, (error as unknown as Record<string, unknown>)[name]]));
    const suffix = Object.keys(details).length ? ` ${JSON.stringify(details)}` : "";
    return `${error.name}: ${error.message}${suffix}`;
  }
  if (error && typeof error === "object") {
    const details = Object.fromEntries(Object.getOwnPropertyNames(error).map((name) => [name, (error as Record<string, unknown>)[name]]));
    return JSON.stringify(details);
  }
  return String(error);
}

type ActivitySnapshot = {
  lastProgressAt: number;
  modelStartedAt?: number;
};

export async function waitForResearchIdle(input: {
  readStatus: () => Promise<"busy" | "retry" | undefined>;
  deadlineAt?: number;
  signal: AbortSignal;
  intervalMs?: number;
  now?: () => number;
  initialGraceMs?: number;
  readActivity?: () => ActivitySnapshot;
  progressStallMs?: number;
  modelStallMs?: number;
  phase?: "RESEARCH" | "PUBLISHING";
}): Promise<void> {
  const now = input.now ?? Date.now;
  let observedBusy = false;
  const startedAt = now();
  while (input.deadlineAt === undefined || now() < input.deadlineAt) {
    input.signal.throwIfAborted();
    const status = await input.readStatus();
    const activity = input.readActivity?.();
    if (input.deadlineAt !== undefined && activity?.modelStartedAt !== undefined && now() - activity.modelStartedAt >= (input.modelStallMs ?? MODEL_STALL_MS)) {
      throw new InvestigationStallError(input.phase ?? "RESEARCH", "Model call exceeded the five-minute liveness limit without completing.", "MODEL_CALL_STALLED");
    }
    if (input.deadlineAt !== undefined && activity && now() - activity.lastProgressAt >= (input.progressStallMs ?? PROGRESS_STALL_MS) && (status === "busy" || status === "retry")) {
      throw new InvestigationStallError(input.phase ?? "RESEARCH", "Investigation made no meaningful progress for three minutes.");
    }
    if (status === "busy" || status === "retry") observedBusy = true;
    else if (observedBusy || (activity && !activity.modelStartedAt && activity.lastProgressAt > startedAt) || now() - startedAt >= (input.initialGraceMs ?? 30_000)) return;
    const interval = input.intervalMs ?? 500;
    if (interval > 0) await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new ResearchDeadlineError();
}

function unwrap<T>(result: { data?: T; error?: unknown }, action: string): T {
  if (result.error || result.data === undefined) throw new Error(`${action} failed: ${describeSdkError(result.error ?? "missing data")}`);
  return result.data;
}

type Input = {
  root: string;
  handle: RunHandle;
  deadlineAt?: Date;
  publishingReserveMs?: number;
  signal: AbortSignal;
  runtime: "LOCAL" | "E2B";
  researchModel: string;
  reportStore: ReportStore;
  researchState: ResearchStateStore;
  sourceStore: FileSourceStore;
  activity: ActivitySnapshot;
  beginPublishing: () => void | Promise<void>;
  persistResearchSnapshot: () => Promise<string>;
  bindResearchSnapshot: (sha256: string) => void | Promise<void>;
  enterPublishing: () => void | Promise<void>;
  onLeadStarted?: (sessionId: string) => void | Promise<void>;
  onProgress?: (message: string) => void;
};

export type HeadlessControllerOutput = {
  result: LeanReportResult;
  leadSessionId: string;
  childSessions: [];
};

export function classifyInvestigationFailure(error: Error, aborted: boolean, runtimeStarted: boolean): { code: string; phase: string } {
  if (error instanceof InvestigationStallError) return { code: error.code, phase: error.phase };
  if (error instanceof ResearchDeadlineError) return { code: error.code, phase: error.phase };
  if (error instanceof ResearchFreezeError) return { code: error.code, phase: "RESEARCH_FREEZE" };
  if (["RESEARCH_SOURCE_INTEGRITY_FAILED", "RESEARCH_SNAPSHOT_WRITE_FAILED", "RESEARCH_SNAPSHOT_VERIFY_FAILED"].includes(error.name)) return { code: error.name, phase: "RESEARCH_FREEZE" };
  return aborted
    ? { code: "CANCELLED_OR_TIMED_OUT", phase: runtimeStarted ? "INVESTIGATION" : "STARTUP" }
    : { code: "INVESTIGATION_FAILED", phase: runtimeStarted ? "INVESTIGATION" : "STARTUP" };
}

export class HeadlessInvestigationController {
  async run(input: Input): Promise<HeadlessControllerOutput> {
    const client = createOpencodeClient({ baseUrl: input.handle.openCodeUrl, headers: input.handle.accessHeaders, throwOnError: false });
    const lead = unwrap(await client.session.create({ directory, title: "Headless Luna investigation", agent: "lead-researcher", model: { id: input.researchModel, providerID: "translucid", variant: "xhigh" } }, { signal: input.signal }), "lead session creation");
      const leadId = lead.id;
      await input.onLeadStarted?.(leadId);
      input.onProgress?.(`Luna investigation session ${leadId} started.`);
      const researchDeadline = input.deadlineAt ? input.deadlineAt.getTime() - (input.publishingReserveMs ?? 0) : undefined;
      const researchAbort = new AbortController();
      const timeout = researchDeadline === undefined
        ? undefined
        : setTimeout(() => researchAbort.abort(new ResearchDeadlineError()), Math.max(1, researchDeadline - Date.now()));
      const abort = () => researchAbort.abort(input.signal.reason);
      input.signal.addEventListener("abort", abort, { once: true });
      let researchFailure: unknown;
      try {
        const launch = await client.session.promptAsync({
          sessionID: leadId,
          directory,
          agent: "lead-researcher",
          model: { providerID: "translucid", modelID: input.researchModel },
          variant: "xhigh",
          parts: [{ type: "text", text: researchPrompt(researchDeadline === undefined ? undefined : new Date(researchDeadline).toISOString()) }],
        }, { signal: researchAbort.signal });
        if (launch.error) throw new Error(`Luna research prompt failed: ${describeSdkError(launch.error)}`);
        await waitForResearchIdle({
          readStatus: async () => {
            const statuses = unwrap(await client.session.status({ directory }, { signal: researchAbort.signal }), "session status");
            const status = statuses[leadId]?.type;
            return status === "busy" || status === "retry" ? status : undefined;
          },
          deadlineAt: researchDeadline,
          signal: researchAbort.signal,
          readActivity: () => input.activity,
          phase: "RESEARCH",
        });
      } catch (error) {
        if (input.signal.aborted) throw error;
        const deadlineFailure = researchAbort.signal.aborted && researchAbort.signal.reason instanceof ResearchDeadlineError ? researchAbort.signal.reason : undefined;
        researchFailure = deadlineFailure ?? error;
        input.onProgress?.(`Research is being frozen: ${researchFailure instanceof Error ? researchFailure.message : String(researchFailure)}`);
        await client.session.abort({ sessionID: leadId, directory }).catch(() => undefined);
      } finally {
        if (timeout) clearTimeout(timeout);
        input.signal.removeEventListener("abort", abort);
      }

      if (researchFailure && !isRecoverableResearchTermination(researchFailure)) throw researchFailure;
      await input.beginPublishing();
      const state = await input.researchState.current();
      if (!state || state.schemaVersion !== 2) {
        throw new ResearchFreezeError("RESEARCH_STATE_REQUIRED", "A valid publication-ready research ledger is required before freeze.", researchFailure instanceof Error ? researchFailure.message : undefined);
      }
      if (!state.publicationReady) {
        throw new ResearchFreezeError("RESEARCH_STATE_NOT_READY", "The durable research ledger is valid but not publication-ready.", researchFailure instanceof Error ? researchFailure.message : undefined);
      }
      const snapshotSha256 = await input.persistResearchSnapshot();
      await input.bindResearchSnapshot(snapshotSha256);
      await input.enterPublishing();
      input.onProgress?.("Research is frozen; host-only structured publication started.");
      await finalizeFrozenResearch({
        root: input.root,
        researchState: input.researchState,
        sourceStore: input.sourceStore,
        reportStore: input.reportStore,
        writer: createOpenCodeStructuredWriter({ client, model: input.researchModel, signal: input.signal }),
        onProgress: input.onProgress,
      });
    const result = await input.reportStore.result(new Date().toISOString());
    return { result, leadSessionId: lead.id, childSessions: [] };
  }
}
