import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { GlobalEvent, Session } from "@opencode-ai/sdk/v2/client";

import type { RunHandle } from "../runtime/types.ts";
import type { MemoryRunBudget } from "./budget.ts";
import type { DossierCheckpointConfig, ResearchCheckpointConfig } from "./checkpoint.ts";
import { describeSdkError, runFinalizationPipeline } from "./finalization-controller.ts";
import { researchPrompt } from "./prompt-contracts.ts";
import type { InvestigationResult } from "./result-contract.ts";
import type { FileSourceStore } from "./source-store.ts";

export { buildFinalizerContext, describeSdkError, extractTextOutput, finalizerPromptPayload, finalizerRepairPayload, finalizerTextPromptPayload, resultForAudit } from "./finalization-controller.ts";

const directory = "/workspace/case";

type Input = {
  runId: string;
  root: string;
  handle: RunHandle;
  deadlineAt: Date;
  finalizationReserveMs: number;
  signal: AbortSignal;
  sourceStore: FileSourceStore;
  budget: MemoryRunBudget;
  runtime: "LOCAL" | "E2B";
  startedAt: string;
  inputSha256: string;
  classification: "SYNTHETIC" | "PUBLIC_PROFESSIONAL";
  researchModel: string;
  compilerModel: string;
  auditorModel: string;
  finalizerProvider: "ZEN" | "GO";
  registerExcerptAllowance: (sessionId: string, characters: number) => void;
  researchCheckpointConfig: ResearchCheckpointConfig;
  dossierCheckpointConfig: DossierCheckpointConfig;
  onLeadStarted?: (sessionId: string) => void | Promise<void>;
  onProgress?: (message: string) => void;
};

export type HeadlessControllerOutput = {
  result: InvestigationResult;
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

export async function readCompletedResearchMemos(memoDirectory: string, children: ChildMemoSession[]): Promise<{
  memos: string[];
  completedSessionIds: Set<string>;
  warnings: string[];
}> {
  const files = await readdir(memoDirectory).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const memos = await Promise.all(files.filter((file) => file.endsWith(".md") && !file.startsWith("lead-")).sort().map((file) => readFile(join(memoDirectory, file), "utf8")));
  if (memos.length === 0) throw new Error("No specialist memo completed; refusing to compile partial reasoning.");
  const completedSessionIds = new Set(memos.flatMap((memo) => memo.match(/^Session:\s*(\S+)\s*$/m)?.[1] ?? []));
  const warnings = children
    .filter((child) => !completedSessionIds.has(child.id))
    .map((child) => `${child.agent ?? "unknown-researcher"} child ${child.id} returned no completed memo; its assigned scope remains unresolved.`);
  return { memos, completedSessionIds, warnings };
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
  throw new DOMException("Finalization reserve began.", "TimeoutError");
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
      lead = unwrap(await client.session.create({ directory, title: "Headless lead research", agent: "lead-researcher", model: { id: input.researchModel, providerID: "translucid", variant: "medium" } }, { signal: input.signal }), "lead session creation");
      const leadId = lead.id;
      await input.onLeadStarted?.(leadId);
      input.onProgress?.(`Lead research session ${leadId} started.`);
      const researchDeadline = input.deadlineAt.getTime() - input.finalizationReserveMs;
      const researchAbort = new AbortController();
      const timeout = setTimeout(() => researchAbort.abort(new DOMException("Finalization reserve began.", "TimeoutError")), Math.max(1, researchDeadline - Date.now()));
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
          variant: "medium",
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
      warnings.push(...handoff.warnings);
      const childSessions = children.map((child) => ({ id: child.id, role: child.agent ?? "unknown-researcher", compactions: compactions.get(child.id) ?? 0 }));
      if (!leadMemo) {
        warnings.push("Lead consolidation was unavailable; compilation used completed specialist memo snapshots only.");
      }
      const limitationMemo = warnings.length ? `\n\n# Research handoff warnings\n\n${warnings.map((warning) => `- ${warning}`).join("\n")}` : "";
      const combinedMemos = `${handoff.memos.join("\n\n")}${leadMemo ? `\n\n# Lead consolidation\n\n${leadMemo}` : ""}${limitationMemo}`;
      if (leadMemo) await writeFile(join(memoDirectory, `lead-${safeFile(lead.id)}.md`), leadMemo, { mode: 0o600 });
      const result = await runFinalizationPipeline({
        ...input,
        researchMemos: combinedMemos,
        warnings,
        researchCheckpointConfig: input.researchCheckpointConfig,
        dossierCheckpointConfig: input.dossierCheckpointConfig,
        deadlineAt: input.deadlineAt.getTime(),
      });
      return { result, leadSessionId: lead.id, childSessions };
    } finally {
      eventAbort.abort();
      await relay;
    }
  }
}
