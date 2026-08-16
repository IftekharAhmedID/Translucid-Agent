import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { GlobalEvent, Session } from "@opencode-ai/sdk/v2/client";

import type { RunHandle } from "../runtime/types.ts";
import { researchPrompt } from "./prompt-contracts.ts";
import { writeResearchSnapshot } from "./recovery.ts";
import type { LeanReportResult, ReportProgress, ReportStore } from "./report-store.ts";

const directory = "/workspace/case";

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

export function draftingPrompt(): string {
  return `Research is complete. Stay in this lead session and draft the investigation through the native report tools. Do not call providers, delegate, restart research, or finalize.

1. Call report.progress.get. Preserve any valid existing findings when resuming.
2. Call report.summary.set with one concise but complete investigation summary: overall result, strongest corroboration, material conflicts, unresolved areas, and limitations.
3. Walk /workspace/case/input/document.json from the first page to the last. Register every important factual résumé assertion with report.finding.upsert. There is no target count.
4. Use one coherent assertion per finding: combine employer, title, location, and interval when they share one evidence conclusion; split unrelated duties, projects, talks, credentials, affiliations, awards, or publications.
5. Use stable IDs F001, F002, and so on. On repair, reuse the same ID.
6. Copy anchor.exact from the specified page and line range. Cite only captured S references already present in this investigation.
7. Write a direct evidence synthesis, not a bibliography dump. Use notes only for a useful caveat.
8. Assign exactly one investigator-owned status: 2 fully corroborated; 1 corroborated with a minor caveat; 0 unclear or insufficient credible public evidence; -1 materially inconsistent; -2 directly contradicted by multiple credible sources. Unresolved is not false.
9. Call report.progress.get again and compare it with your research coverage checklist and every résumé section. Repair omissions, duplicates, over-broad findings, anchors, and source references with upsert/remove.
10. Stop after the draft has a summary and findings. Do not call report.finalize; a separate audit turn will do that.

The backend validates structure and captured references only. You own evidence relevance, status, completeness, and wording.`;
}

export function publishingPrompt(): string {
  return draftingPrompt();
}

export function auditingPrompt(): string {
  return `Research is complete and the draft is complete. Perform a separate adversarial audit in this same lead session. Do not call providers, delegate, or restart research.

1. Call report.progress.get and inspect every draft finding against /workspace/case/input/document.json, the durable specialist memos, and the captured S references already in context.
2. Split any compound finding whose material facets have different evidence, especially entity, role, dates, present status, location, duties, skills, and credentials.
3. Treat résumé, LinkedIn, personal-site, and candidate-written institutional pages as one candidate-origin family unless institutional authorship is evident. Do not call repeated URLs independent corroboration.
4. Challenge every status 2. Require direct authoritative support or genuinely independent strong evidence for every material facet. Downgrade incomplete identity/date fit or candidate-family-only support to 0.
5. Keep status 1 for minor caveats only. Use -1 for a materially stale or inconsistent facet and -2 only for direct contradiction by multiple credible sources. Missing public evidence remains 0.
6. Check exact anchors, source relevance, temporal fit, contradiction handling, negative-evidence coverage, and whether the summary is stronger than the repaired findings.
7. Repair with report.finding.upsert/remove and report.summary.set as needed. Call report.progress.get again.
8. Call report.finalize only after the entire draft is calibrated. Finalization is irreversible for this run.

The backend validates structure and captured references only. You own the semantic audit and calibrated wording.`;
}

export function recoveryPublishingPrompt(): string {
  return `This is publishing-only recovery from completed immutable research. No provider executor is available and no provider, search, delegation, or new research call is permitted.

Read /workspace/case/input/document.json, every completed /workspace/case/.work/memos/*.md file, and /workspace/case/sources/manifest.json. These durable artifacts replace the unavailable original conversation. Use source.excerpts only when a captured S reference needs local detail. Ignore discarded historical report artifacts and use only the current research materials plus the durable report draft.

${draftingPrompt()}`;
}

export async function driveReportPublishing(input: {
  launch: (prompt: string) => Promise<void>;
  waitUntilIdle: () => Promise<void>;
  progress: () => Promise<ReportProgress>;
  beginDrafting?: () => void;
  beginAuditing?: () => void;
  initialPrompt?: string;
}): Promise<ReportProgress> {
  let progress = await input.progress();
  if (progress.state !== "OPEN") return progress;
  input.beginDrafting?.();
  for (let attempt = 0; attempt < 3 && !draftReady(progress); attempt += 1) {
    await input.launch(attempt === 0 ? input.initialPrompt ?? draftingPrompt() : "Continue drafting the existing report. Call report.progress.get, complete the summary and remaining résumé findings, repair anchors and sources, and stop without report.finalize. Do not restart research or call providers.");
    await input.waitUntilIdle();
    progress = await input.progress();
  }
  if (!draftReady(progress)) throw new Error("Lead investigator did not produce a structurally complete report draft after three bounded drafting prompts.");
  input.beginAuditing?.();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await input.launch(attempt === 0 ? auditingPrompt() : "Continue the adversarial audit. Repair remaining findings and summary issues, call report.progress.get, and call report.finalize when the draft is calibrated. Do not restart research or call providers.");
    await input.waitUntilIdle();
    progress = await input.progress();
    if (progress.state !== "OPEN") return progress;
  }
  throw new Error("Lead investigator did not finalize the report after the bounded draft and audit turns.");
}

function draftReady(progress: ReportProgress): boolean {
  return progress.summary.trim().length > 0 && progress.findings.length > 0;
}

export async function runPublishingRecovery(input: {
  handle: RunHandle;
  model: string;
  deadlineAt: number;
  signal: AbortSignal;
  reportStore: ReportStore;
  beginDrafting?: () => void;
  beginAuditing?: () => void;
  onSessionStarted?: (sessionId: string) => void | Promise<void>;
}): Promise<{ result: LeanReportResult; sessionId: string }> {
  const client = createOpencodeClient({ baseUrl: input.handle.openCodeUrl, headers: input.handle.accessHeaders, throwOnError: false });
  const session = unwrap(await client.session.create({
    directory,
    title: "Headless report publishing recovery",
    agent: "lead-researcher",
    model: { id: input.model, providerID: "translucid", variant: "xhigh" },
  }, { signal: input.signal }), "publishing recovery session creation");
  await input.onSessionStarted?.(session.id);
  await driveReportPublishing({
    initialPrompt: recoveryPublishingPrompt(),
    beginDrafting: input.beginDrafting,
    beginAuditing: input.beginAuditing,
    launch: async (prompt) => {
      const launched = await client.session.promptAsync({
        sessionID: session.id,
        directory,
        agent: "lead-researcher",
        model: { providerID: "translucid", modelID: input.model },
        variant: "xhigh",
        parts: [{ type: "text", text: prompt }],
      }, { signal: input.signal });
      if (launched.error) throw new Error(`publishing recovery prompt failed: ${describeSdkError(launched.error)}`);
    },
    waitUntilIdle: () => waitForResearchIdle({
      readStatus: async () => {
        const statuses = unwrap(await client.session.status({ directory }, { signal: input.signal }), "publishing recovery status");
        const status = statuses[session.id]?.type;
        return status === "busy" || status === "retry" ? status : undefined;
      },
      deadlineAt: input.deadlineAt,
      signal: input.signal,
      initialGraceMs: 5_000,
    }),
    progress: () => input.reportStore.progress(),
  });
  return { result: await input.reportStore.result(new Date().toISOString()), sessionId: session.id };
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
  assertResearchReadyForPublishing: () => void;
  beginDrafting: () => void;
  beginAuditing: () => void;
  onLeadStarted?: (sessionId: string) => void | Promise<void>;
  onProgress?: (message: string) => void;
};

export type HeadlessControllerOutput = {
  result: LeanReportResult;
  leadSessionId: string;
  childSessions: Array<{ id: string; role: string; compactions: number }>;
};

function unwrap<T>(result: { data?: T; error?: unknown }, action: string): T {
  if (result.error || result.data === undefined) throw new Error(`${action} failed: ${describeSdkError(result.error ?? "missing data")}`);
  return result.data;
}

function safeFile(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
}

type ChildMemoSession = Pick<Session, "id" | "agent">;
const materialSpecialistRoles = new Set(["professional-researcher", "github-researcher", "web-records-researcher", "social-researcher"]);

export type ResearchHandoffFailure = { sessionId: string; role: string; acceptedMemoCount: number };

export class ResearchHandoffError extends Error {
  readonly code = "RESEARCH_HANDOFF_FAILED";
  readonly phase = "RESEARCH_HANDOFF";

  constructor(readonly failures: ResearchHandoffFailure[], message?: string) {
    super(message ?? `Research handoff is incomplete: ${failures.map(({ role, sessionId, acceptedMemoCount }) => `${role} child ${sessionId} has ${acceptedMemoCount} accepted memos`).join("; ")}.`);
    this.name = "ResearchHandoffError";
  }
}

export function classifyInvestigationFailure(error: Error, aborted: boolean, runtimeStarted: boolean): { code: string; phase: string } {
  if (error instanceof ResearchHandoffError) return { code: error.code, phase: error.phase };
  return aborted
    ? { code: "CANCELLED_OR_TIMED_OUT", phase: runtimeStarted ? "INVESTIGATION" : "STARTUP" }
    : { code: "INVESTIGATION_FAILED", phase: runtimeStarted ? "INVESTIGATION" : "STARTUP" };
}

export async function readCompletedResearchMemos(memoDirectory: string, children: ChildMemoSession[]): Promise<{
  memos: string[];
  completedSessionIds: Set<string>;
}> {
  const files = await readdir(memoDirectory).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const records = await Promise.all(files.filter((file) => file.endsWith(".md") && !file.startsWith("lead-")).sort().map(async (file) => {
    const memo = await readFile(join(memoDirectory, file), "utf8");
    return {
      memo,
      role: memo.match(/^#\s+(\S+)\s+memo\s*$/m)?.[1],
      sessionId: memo.match(/^Session:\s*(\S+)\s*$/m)?.[1],
    };
  }));
  const materialChildren = children.filter((child) => child.agent && materialSpecialistRoles.has(child.agent));
  if (materialChildren.length === 0) throw new ResearchHandoffError([], "No material specialist child was launched; refusing to publish an uninvestigated report.");
  const failures = materialChildren.flatMap((child) => {
    const acceptedMemoCount = records.filter((record) => record.sessionId === child.id && record.role === child.agent).length;
    return acceptedMemoCount === 1 ? [] : [{ sessionId: child.id, role: child.agent!, acceptedMemoCount }];
  });
  if (failures.length) throw new ResearchHandoffError(failures);
  const completedSessionIds = new Set(materialChildren.map(({ id }) => id));
  const memos = records.filter(({ sessionId }) => sessionId && completedSessionIds.has(sessionId)).map(({ memo }) => memo);
  return { memos, completedSessionIds };
}

export async function waitForResearchIdle(input: {
  readStatus: () => Promise<"busy" | "retry" | undefined>;
  deadlineAt: number;
  signal: AbortSignal;
  intervalMs?: number;
  now?: () => number;
  initialGraceMs?: number;
}): Promise<void> {
  const now = input.now ?? Date.now;
  let observedBusy = false;
  const startedAt = now();
  while (now() < input.deadlineAt) {
    input.signal.throwIfAborted();
    const status = await input.readStatus();
    if (status === "busy" || status === "retry") observedBusy = true;
    else if (observedBusy || now() - startedAt >= (input.initialGraceMs ?? 30_000)) return;
    const interval = input.intervalMs ?? 500;
    if (interval > 0) await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new DOMException("Publishing reserve began.", "TimeoutError");
}

function eventSessionId(event: GlobalEvent): string | undefined {
  if (!("properties" in event.payload)) return undefined;
  const properties = event.payload.properties as Record<string, unknown>;
  if (typeof properties.sessionID === "string") return properties.sessionID;
  const part = properties.part;
  return part && typeof part === "object" && typeof (part as { sessionID?: unknown }).sessionID === "string"
    ? String((part as { sessionID: string }).sessionID)
    : undefined;
}

export class HeadlessInvestigationController {
  async run(input: Input): Promise<HeadlessControllerOutput> {
    const client = createOpencodeClient({ baseUrl: input.handle.openCodeUrl, headers: input.handle.accessHeaders, throwOnError: false });
    const compactions = new Map<string, number>();
    const messageRoles = new Map<string, string>();
    const textParts = new Map<string, { sessionId: string; messageId: string; text: string; sequence: number }>();
    let eventSequence = 0;
    const eventAbort = new AbortController();
    const eventConnection = await client.global.event({ signal: eventAbort.signal });
    const relay = (async () => {
      for await (const event of eventConnection.stream) {
        if (event.directory !== directory) continue;
        if (event.payload.type === "session.compacted") {
          const sessionId = event.payload.properties.sessionID;
          compactions.set(sessionId, (compactions.get(sessionId) ?? 0) + 1);
        } else if (event.payload.type === "message.updated") {
          messageRoles.set(event.payload.properties.info.id, event.payload.properties.info.role);
        } else if (event.payload.type === "message.part.updated" && event.payload.properties.part.type === "text") {
          const part = event.payload.properties.part;
          const sessionId = eventSessionId(event);
          if (sessionId && part.text.trim()) textParts.set(part.id, { sessionId, messageId: part.messageID, text: part.text.trim(), sequence: eventSequence++ });
        }
      }
    })().catch(() => undefined);

    let lead: Session | undefined;
    try {
      lead = unwrap(await client.session.create({ directory, title: "Headless lead research", agent: "lead-researcher", model: { id: input.researchModel, providerID: "translucid", variant: "xhigh" } }, { signal: input.signal }), "lead session creation");
      const leadId = lead.id;
      await input.onLeadStarted?.(leadId);
      input.onProgress?.(`Lead research session ${leadId} started.`);
      const researchDeadline = input.deadlineAt.getTime() - input.publishingReserveMs;
      const researchAbort = new AbortController();
      const timeout = setTimeout(() => researchAbort.abort(new DOMException("Publishing reserve began.", "TimeoutError")), Math.max(1, researchDeadline - Date.now()));
      const abort = () => researchAbort.abort(input.signal.reason);
      input.signal.addEventListener("abort", abort, { once: true });
      let leadMemo = "";
      const warnings: string[] = [];
      try {
        const launch = await client.session.promptAsync({
          sessionID: leadId,
          directory,
          agent: "lead-researcher",
          model: { providerID: "translucid", modelID: input.researchModel },
          variant: "xhigh",
          parts: [{ type: "text", text: researchPrompt(new Date(researchDeadline).toISOString()) }],
        }, { signal: researchAbort.signal });
        if (launch.error) throw new Error(`lead research prompt failed: ${describeSdkError(launch.error)}`);
        await waitForResearchIdle({
          readStatus: async () => {
            const statuses = unwrap(await client.session.status({ directory }, { signal: researchAbort.signal }), "session status");
            const status = statuses[leadId]?.type;
            return status === "busy" || status === "retry" ? status : undefined;
          },
          deadlineAt: researchDeadline,
          signal: researchAbort.signal,
        });
        leadMemo = [...textParts.values()]
          .filter((part) => part.sessionId === leadId && messageRoles.get(part.messageId) === "assistant")
          .sort((left, right) => left.sequence - right.sequence)
          .at(-1)?.text ?? "";
      } catch (error) {
        if (input.signal.aborted) throw error;
        warnings.push(`Research stopped before lead consolidation: ${error instanceof Error ? error.message : String(error)}`);
        await client.session.abort({ sessionID: leadId, directory }).catch(() => undefined);
      } finally {
        clearTimeout(timeout);
        input.signal.removeEventListener("abort", abort);
      }

      const children = unwrap(await client.session.children({ sessionID: lead.id, directory }), "child session listing");
      const memoDirectory = join(input.root, ".work", "memos");
      await mkdir(memoDirectory, { recursive: true });
      const handoff = await readCompletedResearchMemos(memoDirectory, children);
      const childSessions = children.map((child) => ({ id: child.id, role: child.agent ?? "unknown-researcher", compactions: compactions.get(child.id) ?? 0 }));
      if (!leadMemo) {
        warnings.push("Lead consolidation was unavailable; compilation used completed specialist memo snapshots only.");
      }
      if (leadMemo) await writeFile(join(memoDirectory, `lead-${safeFile(lead.id)}.md`), leadMemo, { mode: 0o600 });
      await writeResearchSnapshot(input.root, { runtime: input.runtime, researchModel: input.researchModel });
      input.assertResearchReadyForPublishing();
      input.onProgress?.(`Research handoff is durable; lead session ${leadId} entered drafting.`);
      await driveReportPublishing({
        beginDrafting: input.beginDrafting,
        beginAuditing: input.beginAuditing,
        launch: async (prompt) => {
          const launched = await client.session.promptAsync({
            sessionID: leadId,
            directory,
            agent: "lead-researcher",
            model: { providerID: "translucid", modelID: input.researchModel },
            variant: "xhigh",
            parts: [{ type: "text", text: prompt }],
          }, { signal: input.signal });
          if (launched.error) throw new Error(`lead publishing prompt failed: ${describeSdkError(launched.error)}`);
        },
        waitUntilIdle: () => waitForResearchIdle({
          readStatus: async () => {
            const statuses = unwrap(await client.session.status({ directory }, { signal: input.signal }), "session status");
            const status = statuses[leadId]?.type;
            return status === "busy" || status === "retry" ? status : undefined;
          },
          deadlineAt: input.deadlineAt.getTime(),
          signal: input.signal,
          initialGraceMs: 5_000,
        }),
        progress: () => input.reportStore.progress(),
      });
      const result = await input.reportStore.result(new Date().toISOString());
      return { result, leadSessionId: lead.id, childSessions };
    } finally {
      eventAbort.abort();
      await relay;
    }
  }
}
