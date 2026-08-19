import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

import type { RunHandle } from "../runtime/types.ts";
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

const synthesisRecoveryPrompt = "Recover the durable investigation with investigation.progress.get. If synthesis has not started, call investigation.synthesis.begin. Complete every target with one strict finding and assertion-level evidence comments, call investigation.summary.set with every HIGH target ID, then call investigation.commit. Treat host 422 responses as precise validation feedback. Make the tool calls now; do not answer with prose or invent source references.";
const compactSynthesisRecoveryPrompt = "This is a compact-context recovery. Do not search or fetch again. Call investigation.progress.get now, then investigation.synthesis.begin, write one strict finding for every durable target using only captured S# evidence, mark gaps UNRESOLVED, call investigation.summary.set with every HIGH target ID, and call investigation.commit. Make the tool calls now; do not answer with prose.";

type Input = {
  root: string;
  handle: RunHandle;
  deadlineAt?: Date;
  researchDeadlineAt?: Date;
  signal: AbortSignal;
  runtime: "LOCAL" | "E2B";
  researchModel: string;
  researchVariant: string;
  compactContext?: boolean;
  reportStore: ReportStore;
  researchState: ResearchStateStore;
  sourceStore: FileSourceStore;
  activity: ActivitySnapshot;
  persistResearchSnapshot: () => Promise<string>;
  bindResearchSnapshot: (sha256: string) => void | Promise<void>;
  onLeadStarted?: (sessionId: string) => void | Promise<void>;
  onLeadSessionMetadata?: (stage: "created" | "committed", metadata: Record<string, unknown>) => void | Promise<void>;
  onProgress?: (message: string) => void;
};

export type HeadlessControllerOutput = {
  result: LeanReportResult;
  leadSessionId: string;
  leadSession: Record<string, unknown>;
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
    const lead = unwrap(await client.session.create({ directory, title: "Headless DeepSeek V4 Pro investigation", agent: "lead-researcher", model: { id: input.researchModel, providerID: "translucid", variant: input.researchVariant } }, { signal: input.signal }), "lead session creation");
    const leadId = lead.id;
    const sessionMetadata = (session: Record<string, unknown>, observedAfterCommit = false): Record<string, unknown> => {
      const model = session.model && typeof session.model === "object" ? session.model as Record<string, unknown> : {};
      const time = session.time && typeof session.time === "object" ? session.time as Record<string, unknown> : {};
      return {
        id: session.id,
        agent: session.agent,
        model: { id: model.id, providerID: model.providerID, ...(model.variant ? { variant: model.variant } : {}) },
        ...(typeof time.created === "number" ? { createdAt: new Date(time.created).toISOString() } : {}),
        ...(observedAfterCommit ? { observedAfterCommit: { model: { id: model.id, providerID: model.providerID, ...(model.variant ? { variant: model.variant } : {}) }, ...(session.cost !== undefined ? { cost: session.cost } : {}), ...(session.tokens !== undefined ? { tokens: session.tokens } : {}), ...(typeof time.updated === "number" ? { updatedAt: new Date(time.updated).toISOString() } : {}) } } : {}),
      };
    };
    const createdSession = unwrap(await client.session.get({ sessionID: leadId, directory }, { signal: input.signal }), "lead session metadata");
    await input.onLeadSessionMetadata?.("created", sessionMetadata(createdSession as unknown as Record<string, unknown>));
    await input.onLeadStarted?.(leadId);
    input.onProgress?.("Single lead investigation session " + leadId + " started.");
    const researchDeadline = input.researchDeadlineAt?.getTime() ?? input.deadlineAt?.getTime();
    const researchAbort = new AbortController();
    const timeout = researchDeadline === undefined
      ? undefined
      : setTimeout(() => researchAbort.abort(new ResearchDeadlineError()), Math.max(1, researchDeadline - Date.now()));
    const abort = () => researchAbort.abort(input.signal.reason);
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      const launch = await client.session.promptAsync({
        sessionID: leadId,
        directory,
        agent: "lead-researcher",
        model: { providerID: "translucid", modelID: input.researchModel },
        variant: input.researchVariant,
        parts: [{ type: "text", text: researchPrompt(researchDeadline === undefined ? undefined : new Date(researchDeadline).toISOString(), { compactContext: input.compactContext }) }],
      }, { signal: researchAbort.signal });
      if (launch.error) throw new Error("Lead research prompt failed: " + describeSdkError(launch.error));
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
      let state = await input.researchState.current();
      if (!state || state.schemaVersion !== 3 || state.phase !== "COMMITTED") {
        input.onProgress?.("Lead session is continuing durable synthesis and commit recovery.");
        const recovery = unwrap(await client.session.prompt({
          sessionID: leadId,
          directory,
          agent: "lead-researcher",
          model: { providerID: "translucid", modelID: input.researchModel },
          variant: input.researchVariant,
          parts: [{ type: "text", text: input.compactContext ? compactSynthesisRecoveryPrompt : synthesisRecoveryPrompt }],
        }, { signal: researchAbort.signal }), "synthesis recovery prompt");
        if (recovery) await waitForResearchIdle({
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
        state = await input.researchState.current();
      }
      if (!state || state.schemaVersion !== 3 || state.phase !== "COMMITTED") {
        throw new ResearchFreezeError("RESEARCH_STATE_NOT_READY", "The lead must commit a valid v3 investigation before publication.");
      }
      const committedSession = unwrap(await client.session.get({ sessionID: leadId, directory }, { signal: input.signal }), "committed lead session metadata");
      await input.onLeadSessionMetadata?.("committed", sessionMetadata(committedSession as unknown as Record<string, unknown>, true));
      const snapshotSha256 = await input.persistResearchSnapshot();
      await input.bindResearchSnapshot(snapshotSha256);
      await input.reportStore.materializeV3();
      input.onProgress?.("Committed research is frozen; host-only deterministic materialization started.");
    } catch (error) {
      if (input.signal.aborted) throw error;
      await client.session.abort({ sessionID: leadId, directory }).catch(() => undefined);
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      input.signal.removeEventListener("abort", abort);
    }
    const result = await input.reportStore.result(new Date().toISOString());
    const finalSession = await client.session.get({ sessionID: leadId, directory }).then((value) => value.data ? sessionMetadata(value.data as unknown as Record<string, unknown>, true) : ({ id: leadId, agent: "lead-researcher", model: { id: input.researchModel, providerID: "translucid", variant: input.researchVariant } }));
    return { result, leadSessionId: lead.id, leadSession: finalSession, childSessions: [] };
  }
}
