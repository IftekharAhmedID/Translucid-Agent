import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { z } from "zod";

import { extractStructuredOutput } from "../agent/structured-output.ts";
import { finalizerOutputTransport } from "../core/finalizer-transport.ts";
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
  registerExcerptAllowance: (sessionId: string, characters: number) => void;
  researchMemos: string;
  warnings: string[];
  researchCheckpointConfig?: ResearchCheckpointConfig;
  dossierCheckpointConfig: DossierCheckpointConfig;
  reusableDossier?: DossierArtifact;
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
  if (finalizerOutputTransport(provider, model) === "NATIVE_JSON_SCHEMA") {
    return {
      format: { type: "json_schema" as const, schema: z.toJSONSchema(schema) },
      parts: [{ type: "text" as const, text: prompt }],
    };
  }
  return {
    parts: [{
      type: "text" as const,
      text: `${prompt}\n\nReturn only one complete JSON object. It must validate against this JSON Schema:\n${JSON.stringify(z.toJSONSchema(schema))}`,
    }],
  };
}

type AssistantMessage = {
  info: { role: string; error?: { name?: string } };
  parts: Array<{ type: string; text?: string }>;
};

export function extractTextOutput(message: AssistantMessage): string {
  if (message.info.role !== "assistant") throw new Error("Session did not return an assistant response.");
  if (message.info.error) throw new Error(`OPENCODE_MESSAGE_ERROR:${message.info.error.name ?? "UnknownError"}`);
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
  const citedSources: Array<Record<string, unknown>> = [];
  const unknownSourceRefs: string[] = [];
  for (const ref of citedSourceRefs(memoText)) {
    const source = byRef.get(ref);
    if (!source) {
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
  const warnings = unknownSourceRefs.map((ref) => `Research memo cited unknown source ${ref}; that citation was removed and its scope remains unresolved.`);
  const sanitizedMemos = memoText.replace(/\bS([1-9]\d*)\b/g, (ref) => byRef.has(ref) ? ref : "unknown source reference removed");
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

export async function runFinalizationPipeline(input: FinalizationPipelineInput): Promise<InvestigationResult> {
  const client = createOpencodeClient({ baseUrl: input.handle.openCodeUrl, headers: input.handle.accessHeaders, throwOnError: false });
  const warnings = [...input.warnings];
  const compilerBase = await buildFinalizerContext(input.root, input.sourceStore, input.researchMemos);
  warnings.push(...compilerBase.warnings);
  const memoSourceRefs = new Set(compilerBase.citedSources.flatMap((source) => typeof source.ref === "string" ? [source.ref] : []));
  if (input.researchCheckpointConfig) {
    await input.budget.flush();
    await writeResearchCheckpoint(input.root, { warnings, budget: input.budget.snapshot(), config: input.researchCheckpointConfig });
  }

  const promptText = async (title: string, prompt: string, excerptAllowance: number): Promise<string> => {
    const model = input.compilerModel;
    const session = unwrap(await client.session.create({ directory, title, agent: "evidence-compiler", model: { id: model, providerID: "translucid", variant: "medium" } }, { signal: input.signal }), "evidence-compiler session creation");
    input.registerExcerptAllowance(session.id, excerptAllowance);
    const message = unwrap(await client.session.prompt({
      sessionID: session.id,
      directory,
      agent: "evidence-compiler",
      model: { providerID: "translucid", modelID: model },
      variant: "medium",
      parts: [{ type: "text", text: prompt }],
    }, { signal: input.signal }), "evidence-compiler prompt");
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
    const session = unwrap(await client.session.create({ directory, title, agent, model: { id: model, providerID: "translucid", variant: "medium" } }, { signal: input.signal }), `${agent} session creation`);
    input.registerExcerptAllowance(session.id, agent === "evidence-auditor" ? 30_000 : 0);
    const payload = finalizerPromptPayload(input.finalizerProvider, model, prompt, schema);
    const message = unwrap(await client.session.prompt({
      sessionID: session.id,
      directory,
      agent,
      model: { providerID: "translucid", modelID: model },
      variant: "medium",
      tools,
      ...payload,
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
