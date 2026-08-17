import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { Session } from "@opencode-ai/sdk/v2/client";

import type { RunHandle } from "../runtime/types.ts";
import { researchPrompt } from "./prompt-contracts.ts";
import type { ResearchStateStore } from "./research-state.ts";
import type { LeanReportResult, ReportProgress, ReportStore } from "./report-store.ts";

const directory = "/workspace/case";
const MODEL_STALL_MS = 5 * 60_000;
const PROGRESS_STALL_MS = 3 * 60_000;

export class InvestigationStallError extends Error {
  constructor(readonly phase: "RESEARCH" | "PUBLISHING", message: string, readonly code = "INVESTIGATION_STALLED") {
    super(message);
    this.name = "InvestigationStallError";
  }
}

export function canPublishAfterResearchFailure(error: unknown, hasValidClaimState: boolean): boolean {
  return !(error instanceof InvestigationStallError) || hasValidClaimState;
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

export function publishingPrompt(): string {
  return `Research is now frozen in this same Luna session. External provider tools are disabled. Local source.inventory and source.excerpts remain available.

1. First call research.state.set with every material claim you actually investigated. For each claim provide id, claim, provisionalStatus (established, provisional, conflicting, or unresolved), supportingRefs, conflictingRefs, remainingGap, and importance. Use only captured S references.
2. After research.state.set succeeds, call report.progress.get. Preserve any valid existing findings when resuming.
3. Call report.summary.set with one concise but complete investigation summary: overall result, strongest evidence, material conflicts, unresolved areas, and limitations.
4. Walk /workspace/case/input/document.json from the first page to the last. Register every important factual résumé assertion with report.finding.upsert. There is no target count.
5. Use one coherent assertion per finding. Combine employer, title, location, and interval when they share one evidence conclusion; split unrelated duties, projects, talks, credentials, affiliations, awards, or publications.
6. Use stable IDs F001, F002, and so on. On repair, reuse the same ID. Copy anchor.exact from the specified page and line range. Cite only eligible captured S references; SEARCH_DISCOVERY references are leads and cannot be cited.
7. Write direct evidence synthesis, not a bibliography dump. Use notes only for useful caveats. Assign investigator-owned statuses exactly as documented in the report tool.
8. Call report.progress.get again, compare it with the research claim state and every résumé section, then repair omissions, duplicates, anchors, and source references with upsert/remove.
9. Call report.finalize only after that review. Finalization is irreversible for this run.

The host validates structure, source existence, citation eligibility, durability, and ordering. You own evidence relevance, status, completeness, and wording.`;
}

export async function driveReportPublishing(input: {
  launch: (prompt: string) => Promise<void>;
  waitUntilIdle: () => Promise<void>;
  progress: () => Promise<ReportProgress>;
  initialPrompt?: string;
}): Promise<ReportProgress> {
  let progress = await input.progress();
  if (progress.state !== "OPEN") return progress;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await input.launch(attempt === 0 ? input.initialPrompt ?? publishingPrompt() : "Continue publishing the existing draft in this same session. Do not research or call providers. Call report.progress.get, complete or repair the remaining résumé findings, review claim-state and source coverage, and call report.finalize.");
    await input.waitUntilIdle();
    progress = await input.progress();
    if (progress.state !== "OPEN") return progress;
  }
  throw new Error("Lead investigator did not finalize the report after the publishing prompt and one bounded continuation.");
}

type ActivitySnapshot = {
  lastProgressAt: number;
  modelStartedAt?: number;
};

export async function waitForResearchIdle(input: {
  readStatus: () => Promise<"busy" | "retry" | undefined>;
  deadlineAt: number;
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
  while (now() < input.deadlineAt) {
    input.signal.throwIfAborted();
    const status = await input.readStatus();
    const activity = input.readActivity?.();
    if (activity?.modelStartedAt && now() - activity.modelStartedAt >= (input.modelStallMs ?? MODEL_STALL_MS)) {
      throw new InvestigationStallError(input.phase ?? "RESEARCH", "Model call exceeded the five-minute liveness limit without completing.", "MODEL_CALL_STALLED");
    }
    if (activity && now() - activity.lastProgressAt >= (input.progressStallMs ?? PROGRESS_STALL_MS) && (status === "busy" || status === "retry")) {
      throw new InvestigationStallError(input.phase ?? "RESEARCH", "Investigation made no meaningful progress for three minutes.");
    }
    if (status === "busy" || status === "retry") observedBusy = true;
    else if (observedBusy || (activity && !activity.modelStartedAt && activity.lastProgressAt > startedAt) || now() - startedAt >= (input.initialGraceMs ?? 30_000)) return;
    const interval = input.intervalMs ?? 500;
    if (interval > 0) await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new DOMException("Research deadline reached; freezing the investigation.", "TimeoutError");
}

function unwrap<T>(result: { data?: T; error?: unknown }, action: string): T {
  if (result.error || result.data === undefined) throw new Error(`${action} failed: ${describeSdkError(result.error ?? "missing data")}`);
  return result.data;
}

type Input = {
  root: string;
  handle: RunHandle;
  deadlineAt: Date;
  publishingReserveMs: number;
  signal: AbortSignal;
  runtime: "LOCAL" | "E2B";
  researchModel: string;
  reportStore: ReportStore;
  researchState: ResearchStateStore;
  activity: ActivitySnapshot;
  beginPublishing: () => void | Promise<void>;
  persistResearchSnapshot: () => Promise<void>;
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
      const researchDeadline = input.deadlineAt.getTime() - input.publishingReserveMs;
      const researchAbort = new AbortController();
      const timeout = setTimeout(() => researchAbort.abort(new DOMException("Research deadline reached; freezing the investigation.", "TimeoutError")), Math.max(1, researchDeadline - Date.now()));
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
          parts: [{ type: "text", text: researchPrompt(new Date(researchDeadline).toISOString()) }],
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
        researchFailure = error;
        input.onProgress?.(`Research is being frozen: ${error instanceof Error ? error.message : String(error)}`);
        await client.session.abort({ sessionID: leadId, directory }).catch(() => undefined);
      } finally {
        clearTimeout(timeout);
        input.signal.removeEventListener("abort", abort);
      }

      const hasValidClaimState = await input.researchState.hasValidState();
      if (researchFailure && !canPublishAfterResearchFailure(researchFailure, hasValidClaimState)) throw researchFailure;
      await input.beginPublishing();
      if (hasValidClaimState) await input.persistResearchSnapshot();
      input.onProgress?.(`Research is frozen; Luna session ${leadId} entered local publication.`);
      await driveReportPublishing({
        launch: async (prompt) => {
          const launched = await client.session.promptAsync({
            sessionID: leadId,
            directory,
            agent: "lead-researcher",
            model: { providerID: "translucid", modelID: input.researchModel },
            variant: "xhigh",
            parts: [{ type: "text", text: prompt }],
          }, { signal: input.signal });
          if (launched.error) throw new Error(`Luna publishing prompt failed: ${describeSdkError(launched.error)}`);
        },
        waitUntilIdle: () => waitForResearchIdle({
          readStatus: async () => {
            const statuses = unwrap(await client.session.status({ directory }, { signal: input.signal }), "publishing session status");
            const status = statuses[leadId]?.type;
            return status === "busy" || status === "retry" ? status : undefined;
          },
          deadlineAt: input.deadlineAt.getTime(),
          signal: input.signal,
          initialGraceMs: 5_000,
          readActivity: () => input.activity,
          phase: "PUBLISHING",
        }),
        progress: () => input.reportStore.progress(),
      });
    const result = await input.reportStore.result(new Date().toISOString());
    return { result, leadSessionId: lead.id, childSessions: [] };
  }
}
