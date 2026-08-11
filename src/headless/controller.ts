import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { Session } from "@opencode-ai/sdk/v2/client";
import { z } from "zod";

import { extractStructuredOutput } from "../agent/structured-output.ts";
import type { RunHandle } from "../runtime/types.ts";
import type { MemoryRunBudget } from "./budget.ts";
import { finalizeWithSingleRepair, type IndependentAudit } from "./finalize.ts";
import {
  canonicalizeInvestigationResult,
  investigationDraftSchema,
  type InvestigationDraft,
  type InvestigationResult,
} from "./result-contract.ts";
import type { FileSourceStore } from "./source-store.ts";

const directory = "/workspace/case";
const auditSchema = z.object({
  status: z.enum(["PASSED", "REPAIR_REQUIRED"]),
  defects: z.array(z.object({
    severity: z.enum(["MATERIAL", "WARNING"]),
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(2_000),
  }).strict()).max(100),
}).strict();

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
  onLeadStarted?: (sessionId: string) => void | Promise<void>;
  onProgress?: (message: string) => void;
};

export type HeadlessControllerOutput = {
  result: InvestigationResult;
  leadSessionId: string;
  childSessions: Array<{ id: string; role: string; compactions: number }>;
};

function unwrap<T>(result: { data?: T; error?: unknown }, action: string): T {
  if (result.error || result.data === undefined) throw new Error(`${action} failed: ${JSON.stringify(result.error ?? "missing data")}`);
  return result.data;
}

function assistantText(message: { info: { role: string; error?: { name?: string } }; parts: Array<{ type: string; text?: string }> }): string {
  if (message.info.role !== "assistant") return "";
  if (message.info.error) throw new Error(`OpenCode message failed: ${message.info.error.name ?? "UnknownError"}.`);
  return message.parts.flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("").trim();
}

function citedSourceRefs(text: string): string[] {
  return [...new Set([...text.matchAll(/\bS([1-9]\d*)\b/g)].map((match) => `S${match[1]}`))]
    .sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
}

export async function buildFinalizerContext(root: string, sourceStore: FileSourceStore, memoText: string): Promise<{
  input: unknown;
  researchMemos: string;
  citedSources: Array<Record<string, unknown>>;
}> {
  const input: unknown = JSON.parse(await readFile(join(root, "input", "document.json"), "utf8"));
  const sources = await sourceStore.list();
  const byRef = new Map(sources.map((source) => [source.ref, source]));
  const citedSources: Array<Record<string, unknown>> = [];
  for (const ref of citedSourceRefs(memoText)) {
    const source = byRef.get(ref);
    if (!source) throw new Error(`Research memo cites unknown source ${ref}.`);
    citedSources.push({
      ref,
      kind: source.kind,
      url: source.sourceUrl,
      title: source.title,
      provider: source.provider,
      providerRoute: source.providerRoute,
      retrievedAt: source.retrievedAt,
      sourceAuthority: source.sourceAuthority,
      independenceGroup: source.independenceGroup,
      sha256: source.sha256,
      byteLength: source.byteLength,
      mimeType: source.mimeType,
    });
  }
  return { input, researchMemos: memoText, citedSources };
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

export function resultForAudit(result: InvestigationResult, sourceRefs: Set<string>): Omit<InvestigationResult, "audit"> {
  return {
    schemaVersion: result.schemaVersion,
    run: result.run,
    summary: result.summary,
    claims: result.claims,
    evidence: result.evidence,
    timeline: result.timeline,
    sources: result.sources.filter((source) => sourceRefs.has(source.ref)),
  };
}

export class HeadlessInvestigationController {
  async run(input: Input): Promise<HeadlessControllerOutput> {
    const client = createOpencodeClient({ baseUrl: input.handle.openCodeUrl, headers: input.handle.accessHeaders, throwOnError: false });
    const compactions = new Map<string, number>();
    const eventAbort = new AbortController();
    const relay = (async () => {
      const events = await client.global.event({ signal: eventAbort.signal });
      for await (const event of events.stream) {
        if (event.directory !== directory || event.payload.type !== "session.compacted") continue;
        const sessionId = event.payload.properties.sessionID;
        compactions.set(sessionId, (compactions.get(sessionId) ?? 0) + 1);
      }
    })().catch(() => undefined);

    let lead: Session | undefined;
    try {
      lead = unwrap(await client.session.create({ directory, title: "Headless lead research", agent: "lead-researcher", model: { id: input.researchModel, providerID: "translucid", variant: "medium" } }, { signal: input.signal }), "lead session creation");
      await input.onLeadStarted?.(lead.id);
      input.onProgress?.(`Lead research session ${lead.id} started.`);
      const researchDeadline = input.deadlineAt.getTime() - input.finalizationReserveMs;
      const researchAbort = new AbortController();
      const timeout = setTimeout(() => researchAbort.abort(new DOMException("Finalization reserve began.", "TimeoutError")), Math.max(1, researchDeadline - Date.now()));
      const abort = () => researchAbort.abort(input.signal.reason);
      input.signal.addEventListener("abort", abort, { once: true });
      let leadMemo = "";
      const warnings: string[] = [];
      try {
        const message = unwrap(await client.session.prompt({
          sessionID: lead.id,
          directory,
          agent: "lead-researcher",
          model: { providerID: "translucid", modelID: input.researchModel },
          variant: "medium",
          parts: [{ type: "text", text: `Begin the headless investigation from /workspace/case/input/manifest.json. Complete one initial specialist wave and at most one exact-gap targeted wave. Return a consolidated natural-language research memo with exact [S#] citations. The research deadline is ${new Date(researchDeadline).toISOString()}; reserve finalization time and stop when material gaps are resolved or honestly exhausted.` }],
        }, { signal: researchAbort.signal }), "lead research prompt");
        leadMemo = assistantText(message);
      } catch (error) {
        if (input.signal.aborted) throw error;
        warnings.push(`Research stopped before lead consolidation: ${error instanceof Error ? error.message : String(error)}`);
        await client.session.abort({ sessionID: lead.id, directory }).catch(() => undefined);
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
      const compilerBase = await buildFinalizerContext(input.root, input.sourceStore, combinedMemos);
      const memoSourceRefs = new Set(compilerBase.citedSources.flatMap((source) => typeof source.ref === "string" ? [source.ref] : []));

      const promptJson = async <T>(agent: "evidence-compiler" | "evidence-auditor", title: string, prompt: string, schema: z.ZodType<T>): Promise<T> => {
        const model = agent === "evidence-compiler" ? input.compilerModel : input.auditorModel;
        const session = unwrap(await client.session.create({ directory, title, agent, model: { id: model, providerID: "translucid", variant: "medium" } }, { signal: input.signal }), `${agent} session creation`);
        const message = unwrap(await client.session.prompt({
          sessionID: session.id,
          directory,
          agent,
          model: { providerID: "translucid", modelID: model },
          variant: "medium",
          parts: [{ type: "text", text: `${prompt}\n\nReturn only one complete JSON object. It must validate against this JSON Schema:\n${JSON.stringify(z.toJSONSchema(schema))}` }],
        }, { signal: input.signal }), `${agent} prompt`);
        return schema.parse(extractStructuredOutput(message));
      };

      const provisionalRun = {
        id: input.runId,
        runtime: input.runtime,
        startedAt: input.startedAt,
        finishedAt: input.startedAt,
        inputSha256: input.inputSha256,
        classification: input.classification,
        models: { research: input.researchModel, compiler: input.compilerModel, auditor: input.auditorModel },
        budgets: { ...input.budget.snapshot(), routeCounts: undefined },
      } as const;
      const validated = await finalizeWithSingleRepair<InvestigationDraft, InvestigationResult>({
        compile: async ({ attempt, defects, previousDraft }) => promptJson(
          "evidence-compiler",
          `Evidence compiler ${attempt}`,
          `Compile the supplied research into the semantic-key draft contract. Backend code will assign canonical IDs, authority, verdicts, strength, and statistics. Map every evidence item to one claim and one or more declared facets. Preserve every material input assertion or explain its lack of eligible evidence with an unresolved facet. Use source.excerpts to inspect memo-cited immutable sources; request at most 60,000 characters per call. Exact quotes must occur verbatim in the stored source.\n\n${JSON.stringify({ ...compilerBase, repairDefects: defects, previousDraft })}`,
          investigationDraftSchema,
        ),
        validate: (draft) => canonicalizeInvestigationResult(draft, {
          run: provisionalRun,
          sourceStore: input.sourceStore,
          compilerAttempts: 1,
          auditorAttempts: 1,
          warnings,
          providerCalls: input.budget.snapshot().externalNetworkCalls,
        }),
        audit: async (result, attempt): Promise<IndependentAudit> => {
          const audit = await promptJson(
            "evidence-auditor",
            `Evidence audit ${attempt}`,
            `Independently audit this deterministically validated result against the supplied input and research. Use source.excerpts for any exact-source check and request at most 60,000 characters per call. Mark REPAIR_REQUIRED only for a material defect. Warnings do not require repair.\n\n${JSON.stringify({ result: resultForAudit(result, memoSourceRefs), input: compilerBase.input, researchMemos: compilerBase.researchMemos, citedSources: compilerBase.citedSources })}`,
            auditSchema,
          );
          const material = audit.defects.filter((defect) => defect.severity === "MATERIAL").map((defect) => `${defect.code}: ${defect.message}`);
          return { status: audit.status === "PASSED" && material.length === 0 ? "PASSED" : "REPAIR_REQUIRED", defects: material };
        },
      });

      const requestStats = await input.sourceStore.requestStats();
      const result = await canonicalizeInvestigationResult(validated.draft, {
        run: {
          ...provisionalRun,
          finishedAt: new Date().toISOString(),
          budgets: {
            modelUsd: input.budget.snapshot().modelUsd,
            providerUsd: input.budget.snapshot().providerUsd,
            externalNetworkCalls: input.budget.snapshot().externalNetworkCalls,
          },
        },
        sourceStore: input.sourceStore,
        compilerAttempts: validated.compilerAttempts,
        auditorAttempts: validated.auditorAttempts,
        warnings,
        providerCalls: requestStats.providerCalls,
        cacheHits: requestStats.cacheHits,
      });
      input.onProgress?.(`Final audit passed with ${result.claims.length} claims and ${result.evidence.length} evidence items.`);
      return { result, leadSessionId: lead.id, childSessions };
    } finally {
      eventAbort.abort();
      await relay;
    }
  }
}
