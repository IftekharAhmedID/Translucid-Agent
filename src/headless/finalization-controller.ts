import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { z } from "zod";

import { extractMarkedJson } from "../agent/structured-output.ts";
import { FINALIZER_TEXT_MODE_MARKER, finalizerOutputTransport } from "../core/finalizer-transport.ts";
import type { RunHandle } from "../runtime/types.ts";
import type { MemoryRunBudget } from "./budget.ts";
import {
  DOSSIER_PATH,
  writeDossierCheckpoint,
  writeResearchCheckpoint,
  type DossierCheckpointConfig,
  type ResearchCheckpointConfig,
} from "./checkpoint.ts";
import { assertDossierMatchesDraft, parseEvidenceDossier, type DossierInventory } from "./dossier.ts";
import { finalizeWithSingleRepair, type IndependentAudit } from "./finalize.ts";
import { AUDITOR_PROMPT_CONTRACT, DOSSIER_PROMPT_CONTRACT, ENCODER_PROMPT_CONTRACT, promptWithPayload } from "./prompt-contracts.ts";
import {
  canonicalizeInvestigationResult,
  investigationDraftSchema,
  type InvestigationDraft,
  type InvestigationResult,
} from "./result-contract.ts";
import type { FileSourceStore } from "./source-store.ts";
import type { PacketDossier } from "./packet-dossier.ts";

const directory = "/workspace/case";
const auditSchema = z.object({
  status: z.enum(["PASSED", "REPAIR_REQUIRED"]),
  defects: z.array(z.object({
    severity: z.enum(["MATERIAL", "WARNING"]),
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(2_000),
  }).strict()).max(100),
}).strict();

export type DossierArtifact = { text: string; inventory: DossierInventory };

export type FinalizationPipelineInput = {
  runId: string;
  root: string;
  handle: RunHandle;
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
  deadlineAt: number;
  registerExcerptAllowance: (sessionId: string, characters: number) => void;
  researchMemos: string;
  warnings: string[];
  researchCheckpointConfig?: ResearchCheckpointConfig;
  dossierCheckpointConfig: DossierCheckpointConfig;
  reusableDossier?: DossierArtifact;
  reusablePacketDossier?: PacketDossier;
  onProgress?: (message: string) => void;
};

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

export function finalizerPromptPayload<T>(provider: "ZEN" | "GO", model: string, prompt: string, schema: z.ZodType<T>) {
  void finalizerOutputTransport(provider, model);
  return {
    system: FINALIZER_TEXT_MODE_MARKER,
    parts: [{
      type: "text" as const,
      text: `${prompt}\n\nReturn exactly one JSON object inside these markers:\n<RESULT_JSON>\n{\"replace\":\"with the complete result\"}\n</RESULT_JSON>\nThe object must validate against this JSON Schema:\n${JSON.stringify(z.toJSONSchema(schema))}`,
    }],
  };
}

export function finalizerRepairPayload(originalResponse: string, validatorError: string) {
  return { originalResponse, validatorError };
}

export function finalizerTextPromptPayload(prompt: string) {
  return {
    system: FINALIZER_TEXT_MODE_MARKER,
    parts: [{ type: "text" as const, text: prompt }],
  };
}

export type AssistantMessage = {
  info: { role: string; error?: { name?: string; [key: string]: unknown }; structured?: unknown };
  parts: Array<{ type: string; text?: string }>;
};

function hasAssistantOutput(message: AssistantMessage): boolean {
  return message.info.role === "assistant"
    && (message.info.error !== undefined
      || message.info.structured !== undefined
      || message.parts.some((part) => part.type === "text" && typeof part.text === "string" && part.text.length > 0));
}

export async function waitForFinalizerAssistant(input: {
  readStatus: () => Promise<"busy" | "retry" | "idle" | undefined>;
  readMessages: () => Promise<ReadonlyArray<AssistantMessage>>;
  readLaunchError?: () => unknown;
  deadlineAt: number;
  signal: AbortSignal;
  intervalMs?: number;
  initialGraceMs?: number;
}): Promise<AssistantMessage> {
  const now = Date.now;
  const startedAt = now();
  let observedBusy = false;
  while (now() < input.deadlineAt) {
    input.signal.throwIfAborted();
    const status = await input.readStatus();
    if (status === "busy" || status === "retry") observedBusy = true;
    const idle = status === "idle" || status === undefined;
    if (idle) {
      const message = [...await input.readMessages()].reverse().find(hasAssistantOutput);
      if (message) return message;
      const launchError = input.readLaunchError?.();
      if (launchError && status === "idle") throw launchError;
      if (status === "idle" && (observedBusy || now() - startedAt >= (input.initialGraceMs ?? 30_000))) {
        throw new Error("Finalizer session became idle with no assistant response.");
      }
    }
    const interval = input.intervalMs ?? 500;
    if (interval > 0) await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new DOMException("Finalization deadline reached.", "TimeoutError");
}

export function extractTextOutput(message: AssistantMessage): string {
  if (message.info.role !== "assistant") throw new Error("Session did not return an assistant response.");
  if (message.info.error) throw new Error(`OPENCODE_MESSAGE_ERROR:${describeSdkError(message.info.error)}`);
  const text = message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
  if (!text) throw new Error("Evidence dossier session returned no text.");
  return text;
}

function unwrap<T>(result: { data?: T; error?: unknown }, action: string): T {
  if (result.error || result.data === undefined) throw new Error(`${action} failed: ${describeSdkError(result.error ?? "missing data")}`);
  return result.data;
}

function citedSourceRefs(text: string): string[] {
  return [...new Set([...text.matchAll(/\bS([1-9]\d*)\b/g)].map((match) => `S${match[1]}`))]
    .sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
}

export async function buildFinalizerContext(root: string, sourceStore: FileSourceStore, memoText: string): Promise<{
  input: unknown;
  researchMemos: string;
  citedSources: Array<Record<string, unknown>>;
  warnings: string[];
}> {
  const input: unknown = JSON.parse(await readFile(join(root, "input", "document.json"), "utf8"));
  const sources = await sourceStore.list();
  const byRef = new Map(sources.map((source) => [source.ref, source]));
  const specialistCitedRefs = new Set<string>();
  const sidecarDirectory = join(root, ".work", "memos");
  const sidecars = await readdir(sidecarDirectory).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
  for (const file of sidecars.filter((name) => name.endsWith(".sources.json"))) {
    try {
      const sidecar = JSON.parse(await readFile(join(sidecarDirectory, file), "utf8")) as { citedSourceRefs?: unknown };
      if (Array.isArray(sidecar.citedSourceRefs)) for (const ref of sidecar.citedSourceRefs) if (typeof ref === "string") specialistCitedRefs.add(ref);
    } catch {
      // Research checkpoint validation reports malformed sidecars; finalizer context remains fail-closed if it is reached directly.
    }
  }
  const specialistEligibility = specialistCitedRefs.size ? specialistCitedRefs : undefined;
  const citedSources: Array<Record<string, unknown>> = [];
  const unknownSourceRefs: string[] = [];
  for (const ref of citedSourceRefs(memoText)) {
    const source = byRef.get(ref);
    if (!source || (specialistEligibility && !specialistEligibility.has(ref))) {
      unknownSourceRefs.push(ref);
      continue;
    }
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
  const warnings = unknownSourceRefs.map((ref) => specialistEligibility && !specialistEligibility.has(ref)
    ? `Lead or research memo cited source ${ref} outside the validated specialist reference union; that citation was removed and its scope remains unresolved.`
    : `Research memo cited unknown source ${ref}; that citation was removed and its scope remains unresolved.`);
  const sanitizedMemos = memoText.replace(/\bS([1-9]\d*)\b/g, (ref) => byRef.has(ref) && (!specialistEligibility || specialistEligibility.has(ref)) ? ref : "unknown source reference removed");
  const sourceWarning = warnings.length
    ? `\n\n# Source-reference warning\n\n- ${warnings.length === 1 ? "An unknown source reference was removed" : `${warnings.length} unknown source references were removed`}; any statement relying only on removed references remains unresolved.`
    : "";
  return { input, researchMemos: `${sanitizedMemos}${sourceWarning}`, citedSources, warnings };
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

async function atomicWriteText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function runLegacyFinalizationPipeline(input: FinalizationPipelineInput): Promise<InvestigationResult> {
  const client = createOpencodeClient({ baseUrl: input.handle.openCodeUrl, headers: input.handle.accessHeaders, throwOnError: false });
  const warnings = [...input.warnings];
  const compilerBase = await buildFinalizerContext(input.root, input.sourceStore, input.researchMemos);
  warnings.push(...compilerBase.warnings);
  const memoSourceRefs = new Set(compilerBase.citedSources.flatMap((source) => typeof source.ref === "string" ? [source.ref] : []));
  if (input.researchCheckpointConfig) {
    await input.budget.flush();
    await writeResearchCheckpoint(input.root, { warnings, budget: input.budget.snapshot(), config: input.researchCheckpointConfig });
  }

  const promptSession = async (
    agent: "evidence-compiler" | "evidence-auditor",
    title: string,
    payload: Record<string, unknown>,
    excerptAllowance: number,
  ): Promise<AssistantMessage> => {
    const model = agent === "evidence-compiler" ? input.compilerModel : input.auditorModel;
    const session = unwrap(await client.session.create({ directory, title, agent, model: { id: model, providerID: "translucid", variant: "medium" } }, { signal: input.signal }), `${agent} session creation`);
    input.registerExcerptAllowance(session.id, excerptAllowance);
    let launchError: unknown;
    void client.session.promptAsync({
      sessionID: session.id,
      directory,
      agent,
      model: { providerID: "translucid", modelID: model },
      variant: "medium",
      ...payload,
    }, { signal: input.signal }).then((launch) => {
      if (launch.error) launchError = new Error(`${agent} prompt failed: ${describeSdkError(launch.error)}`);
    }).catch((error) => {
      launchError = new Error(`${agent} prompt failed: ${describeSdkError(error)}`);
    });
    return waitForFinalizerAssistant({
      readStatus: async () => {
        const statuses = unwrap(await client.session.status({ directory }, { signal: input.signal }), `${agent} session status`);
        return statuses[session.id]?.type;
      },
      readMessages: async () => {
        const messages = unwrap(await client.session.messages({ sessionID: session.id, directory, limit: 20 }, { signal: input.signal }), `${agent} session messages`) as unknown as ReadonlyArray<AssistantMessage>;
        return messages;
      },
      readLaunchError: () => launchError,
      deadlineAt: input.deadlineAt,
      signal: input.signal,
    });
  };

  const promptText = async (title: string, prompt: string, excerptAllowance: number): Promise<string> => {
    const message = await promptSession("evidence-compiler", title, finalizerTextPromptPayload(prompt), excerptAllowance);
    return extractTextOutput(message);
  };

  const promptJson = async <T>(
    agent: "evidence-compiler" | "evidence-auditor",
    title: string,
    prompt: string,
    schema: z.ZodType<T>,
    tools?: Record<string, boolean>,
  ): Promise<T> => {
    const model = agent === "evidence-compiler" ? input.compilerModel : input.auditorModel;
    const payload = finalizerPromptPayload(input.finalizerProvider, model, prompt, schema);
    const message = await promptSession(agent, title, { tools, ...payload }, agent === "evidence-auditor" ? 30_000 : 0);
    return schema.parse(extractMarkedJson(message));
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
  let lastDossierText = input.reusableDossier?.text;
  let reusableDossier = input.reusableDossier;
  const validated = await finalizeWithSingleRepair<DossierArtifact, InvestigationDraft, InvestigationResult>({
    createDossier: async ({ attempt, defects, previousDossier }) => {
      if (attempt === 1 && reusableDossier) {
        const reused = reusableDossier;
        reusableDossier = undefined;
        return reused;
      }
      const text = await promptText(
        `Evidence dossier ${attempt}`,
        promptWithPayload(DOSSIER_PROMPT_CONTRACT, { ...compilerBase, repairDefects: defects, previousDossier: previousDossier?.text ?? lastDossierText }),
        attempt === 1 ? 60_000 : 15_000,
      );
      lastDossierText = text;
      const inventory = parseEvidenceDossier(text, memoSourceRefs);
      await atomicWriteText(join(input.root, DOSSIER_PATH), `${text.trim()}\n`);
      await writeDossierCheckpoint(input.root, { inventory, config: input.dossierCheckpointConfig });
      return { text, inventory };
    },
    encode: async ({ attempt, dossier, defects, previousDraft }) => promptJson(
      "evidence-compiler",
      `Structured evidence encoding ${attempt}`,
      promptWithPayload(ENCODER_PROMPT_CONTRACT, { input: compilerBase.input, evidenceDossier: dossier.text, repairDefects: defects, previousDraft }),
      investigationDraftSchema,
      { "source.excerpts": false, skill: false },
    ),
    validateEncoding: (dossier, draft) => assertDossierMatchesDraft(dossier.inventory, draft),
    validateResult: (draft) => canonicalizeInvestigationResult(draft, {
      run: provisionalRun,
      sourceStore: input.sourceStore,
      compilerAttempts: 1,
      auditorAttempts: 1,
      warnings,
      providerCalls: input.budget.snapshot().externalNetworkCalls,
    }),
    audit: async (result, dossier, attempt): Promise<IndependentAudit> => {
      const audit = await promptJson(
        "evidence-auditor",
        `Evidence audit ${attempt}`,
        promptWithPayload(AUDITOR_PROMPT_CONTRACT, { result: resultForAudit(result, memoSourceRefs), input: compilerBase.input, evidenceDossier: dossier.text, citedSources: compilerBase.citedSources }),
        auditSchema,
      );
      const material = audit.defects.filter((defect) => defect.severity === "MATERIAL").map((defect) => `${defect.code}: ${defect.message}`);
      return { status: audit.status === "PASSED" && material.length === 0 ? "PASSED" : "REPAIR_REQUIRED", defects: material };
    },
  });

  await input.budget.flush();
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
  return result;
}

/**
 * The production finalizer is packetized and host-merged. The former TL/encoder
 * implementation remains exported only as a compatibility seam for preserved
 * fixtures while old checkpoints are being retired.
 */
export async function runFinalizationPipeline(input: FinalizationPipelineInput): Promise<InvestigationResult> {
  const { runIncrementalFinalization } = await import("./incremental-pipeline.ts");
  return runIncrementalFinalization(input);
}
