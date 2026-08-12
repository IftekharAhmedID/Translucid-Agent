import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { extractStructuredOutput } from "../agent/structured-output.ts";
import type { RunHandle } from "../runtime/types.ts";
import type { MemoryRunBudget } from "./budget.ts";
import { writePacketDossierCheckpoint, writeResearchCheckpoint, type DossierCheckpointConfig, type ResearchCheckpointConfig } from "./checkpoint.ts";
import {
  buildFinalizerContext,
  describeSdkError,
  finalizerPromptPayload,
  resultForAudit,
  waitForFinalizerAssistant,
  type AssistantMessage,
} from "./finalization-controller.ts";
import {
  mergePacketDossier,
  packetDossierToDraft,
  splitClaimPackets,
  validateCoveragePlan,
  validatePacket,
  coveragePlanSchema,
  packetSchema,
  summaryTimelineOutputSchema,
  renderEvidenceDossierMarkdown,
  type PacketDossier,
} from "./packet-dossier.ts";
import { AUDITOR_PROMPT_CONTRACT, COVERAGE_PROMPT_CONTRACT, PACKET_PROMPT_CONTRACT, SUMMARY_TIMELINE_PROMPT_CONTRACT, promptWithPayload } from "./prompt-contracts.ts";
import { canonicalizeInvestigationResult, type InvestigationResult } from "./result-contract.ts";
import type { FileSourceStore } from "./source-store.ts";

const directory = "/workspace/case";
const auditSchema = z.object({
  status: z.enum(["PASSED", "REPAIR_REQUIRED"]),
  defects: z.array(z.object({ severity: z.enum(["MATERIAL", "WARNING"]), code: z.string().min(1), message: z.string().min(1) }).strict()).max(100),
}).strict();

type Input = {
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
  dossierCheckpointConfig?: DossierCheckpointConfig;
  reusablePacketDossier?: PacketDossier;
  onProgress?: (message: string) => void;
};

export type PacketFinalizationArtifact = { dossier: PacketDossier; markdown: string };

function sourceRefsFromMetadata(sources: Array<Record<string, unknown>>): Set<string> {
  return new Set(sources.flatMap((source) => {
    if (typeof source.ref !== "string") return [];
    const authority = typeof source.sourceAuthority === "string" ? source.sourceAuthority : "CONTEXT";
    return authority === "CONTEXT" || authority === "DISCOVERY_ONLY" ? [] : [source.ref];
  }));
}

async function writeAtomic(path: string, value: string): Promise<void> {
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

export async function runPacketizedFinalization(input: Input): Promise<{ result: InvestigationResult; artifact: PacketFinalizationArtifact; compilerAttempts: 1 | 2; auditorAttempts: 1 | 2 }> {
  const client = createOpencodeClient({ baseUrl: input.handle.openCodeUrl, headers: input.handle.accessHeaders, throwOnError: false });
  const base = await buildFinalizerContext(input.root, input.sourceStore, input.researchMemos);
  const warnings = [...input.warnings, ...base.warnings];
  const allowedSourceRefs = sourceRefsFromMetadata(base.citedSources);
  if (input.researchCheckpointConfig) {
    await input.budget.flush();
    await writeResearchCheckpoint(input.root, { warnings, budget: input.budget.snapshot(), config: input.researchCheckpointConfig });
  }
  let reusablePacketDossier = input.reusablePacketDossier;
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

  const promptSession = async (agent: "evidence-compiler" | "evidence-auditor", title: string, payload: Record<string, unknown>, allowance: number): Promise<AssistantMessage> => {
    const model = agent === "evidence-compiler" ? input.compilerModel : input.auditorModel;
    const session = unwrap(await client.session.create({ directory, title, agent, model: { id: model, providerID: "translucid", variant: "medium" } }, { signal: input.signal }), `${agent} session creation`);
    input.registerExcerptAllowance(session.id, allowance);
    let launchError: unknown;
    void client.session.promptAsync({ sessionID: session.id, directory, agent, model: { providerID: "translucid", modelID: model }, variant: "medium", ...payload }, { signal: input.signal })
      .then((launch) => { if (launch.error) launchError = new Error(`${agent} prompt failed: ${describeSdkError(launch.error)}`); })
      .catch((error) => { launchError = new Error(`${agent} prompt failed: ${describeSdkError(error)}`); });
    return waitForFinalizerAssistant({
      readStatus: async () => {
        const statuses = unwrap(await client.session.status({ directory }, { signal: input.signal }), `${agent} session status`);
        return statuses[session.id]?.type;
      },
      readMessages: async () => unwrap(await client.session.messages({ sessionID: session.id, directory, limit: 20 }, { signal: input.signal }), `${agent} session messages`) as unknown as ReadonlyArray<AssistantMessage>,
      readLaunchError: () => launchError,
      deadlineAt: input.deadlineAt,
      signal: input.signal,
    });
  };

  const promptJson = async <T>(agent: "evidence-compiler" | "evidence-auditor", title: string, contract: string, payload: unknown, schema: z.ZodType<T>, allowance: number, tools: Record<string, boolean>): Promise<T> => {
    const model = agent === "evidence-compiler" ? input.compilerModel : input.auditorModel;
    const response = await promptSession(agent, title, { tools, ...finalizerPromptPayload(input.finalizerProvider, model, promptWithPayload(contract, payload), schema) }, allowance);
    return schema.parse(extractStructuredOutput(response));
  };

  const parsedInput = base.input as { pages?: unknown[] };
  const packetRun = async (repairDefects: string[] = []): Promise<{ dossier: PacketDossier; result: InvestigationResult }> => {
    if (!repairDefects.length && reusablePacketDossier) {
      const dossier = reusablePacketDossier;
      reusablePacketDossier = undefined;
      const draft = packetDossierToDraft(dossier);
      const result = await canonicalizeInvestigationResult(draft, {
        run: provisionalRun,
        sourceStore: input.sourceStore,
        compilerAttempts: 1,
        auditorAttempts: 1,
        warnings,
        providerCalls: input.budget.snapshot().externalNetworkCalls,
      });
      return { dossier, result };
    }
    const coverageValue = await promptJson("evidence-compiler", "Exhaustive coverage outline", COVERAGE_PROMPT_CONTRACT, { input: parsedInput, repairDefects }, coveragePlanSchema, 0, { "source.excerpts": false, skill: false });
    const coverage = validateCoveragePlan(coverageValue, parsedInput as never);
    const outlines = coverage.claims;
    const packets = splitClaimPackets(outlines, 5);
    const packetAllowance = packets.length ? Math.floor((repairDefects.length ? 15_000 : 60_000) / packets.length) : 0;
    const packetResults: unknown[] = new Array(packets.length);
    let next = 0;
    const worker = async () => {
      while (true) {
        const index = next++;
        if (index >= packets.length) return;
        const value = await promptJson("evidence-compiler", `Evidence packet ${index + 1}/${packets.length}`, PACKET_PROMPT_CONTRACT, {
          input: parsedInput,
          claimOutlines: packets[index],
          researchMemos: base.researchMemos,
          citedSources: base.citedSources,
          warnings,
          repairDefects,
        }, packetSchema, packetAllowance, { "source.excerpts": true, skill: true });
        packetResults[index] = validatePacket(value, packets[index]!, allowedSourceRefs);
      }
    };
    await Promise.all([worker(), worker()]);
    const summaryOutput = await promptJson("evidence-compiler", "Summary and timeline", SUMMARY_TIMELINE_PROMPT_CONTRACT, {
      input: parsedInput,
      claims: packetResults.flatMap((packet) => (packet as { claims: unknown[] }).claims),
      evidence: packetResults.flatMap((packet) => (packet as { evidence: unknown[] }).evidence),
      repairDefects,
    }, summaryTimelineOutputSchema, 0, { "source.excerpts": false, skill: false });
    const dossier = mergePacketDossier(coverage, packetResults, summaryOutput.summary, summaryOutput.timeline, allowedSourceRefs);
    await writeAtomic(join(input.root, ".work/finalization/evidence-dossier.json"), `${JSON.stringify(dossier, null, 2)}\n`);
    await writeAtomic(join(input.root, ".work/finalization/evidence-dossier.md"), renderEvidenceDossierMarkdown(dossier));
    if (input.dossierCheckpointConfig) await writePacketDossierCheckpoint(input.root, { dossier, config: input.dossierCheckpointConfig });
    const draft = packetDossierToDraft(dossier);
    const result = await canonicalizeInvestigationResult(draft, {
      run: provisionalRun,
      sourceStore: input.sourceStore,
      compilerAttempts: repairDefects.length ? 2 : 1,
      auditorAttempts: 1,
      warnings,
      providerCalls: input.budget.snapshot().externalNetworkCalls,
    });
    return { dossier, result };
  };

  let compilerAttempts: 1 | 2 = 1;
  let auditorAttempts: 1 | 2 = 1;
  let current: { dossier: PacketDossier; result: InvestigationResult };
  try {
    current = await packetRun();
  } catch (error) {
    compilerAttempts = 2;
    current = await packetRun([`Finalization defect: ${error instanceof Error ? error.message : String(error)}`]);
  }

  const audit = await promptJson("evidence-auditor", "Independent evidence audit", AUDITOR_PROMPT_CONTRACT, {
    input: parsedInput,
    dossier: current.dossier,
    result: resultForAudit(current.result, allowedSourceRefs),
    citedSources: base.citedSources,
  }, auditSchema, 30_000, { "source.excerpts": false, skill: false });
  const material = audit.defects.filter((defect) => defect.severity === "MATERIAL").map((defect) => `${defect.code}: ${defect.message}`);
  if (audit.status !== "PASSED" || material.length) {
    if (compilerAttempts === 2) throw new Error(`Independent evidence audit failed after the single repair: ${material.join("; ") || "unspecified material defect"}`);
    compilerAttempts = 2;
    current = await packetRun(material);
    const second = await promptJson("evidence-auditor", "Independent evidence audit after repair", AUDITOR_PROMPT_CONTRACT, { input: parsedInput, dossier: current.dossier, result: resultForAudit(current.result, allowedSourceRefs), citedSources: base.citedSources }, auditSchema, 30_000, { "source.excerpts": false, skill: false });
    auditorAttempts = 2;
    const secondMaterial = second.defects.filter((defect) => defect.severity === "MATERIAL").map((defect) => `${defect.code}: ${defect.message}`);
    if (second.status !== "PASSED" || secondMaterial.length) throw new Error(`Independent evidence audit failed after the single repair: ${secondMaterial.join("; ") || "unspecified material defect"}`);
  }

  await input.budget.flush();
  const requestStats = await input.sourceStore.requestStats();
  const result = await canonicalizeInvestigationResult(packetDossierToDraft(current.dossier), {
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
    compilerAttempts,
    auditorAttempts,
    warnings,
    providerCalls: requestStats.providerCalls,
    cacheHits: requestStats.cacheHits,
  });
  input.onProgress?.(`Final audit passed with ${result.claims.length} claims and ${result.evidence.length} evidence items.`);
  return { result, artifact: { dossier: current.dossier, markdown: renderEvidenceDossierMarkdown(current.dossier) }, compilerAttempts, auditorAttempts };
}

function unwrap<T>(result: { data?: T; error?: unknown }, action: string): T {
  if (result.error || result.data === undefined) throw new Error(`${action} failed: ${describeSdkError(result.error ?? "missing data")}`);
  return result.data;
}
