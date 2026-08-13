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
  validatePacketEvidence,
  coveragePlanSchema,
  packetSchema,
  summaryTimelineOutputSchema,
  renderEvidenceDossierMarkdown,
  type CoveragePlan,
  type Packet,
  type PacketDossier,
} from "./packet-dossier.ts";
import { AUDITOR_PROMPT_CONTRACT, COVERAGE_PROMPT_CONTRACT, PACKET_PROMPT_CONTRACT, SUMMARY_TIMELINE_PROMPT_CONTRACT, promptWithPayload } from "./prompt-contracts.ts";
import { canonicalizeInvestigationResult, type InvestigationResult } from "./result-contract.ts";
import type { FileSourceStore } from "./source-store.ts";
import { loadSourceAuthority } from "./source-authority.ts";

const directory = "/workspace/case";
export type FinalizationStage = "COVERAGE" | "PACKET" | "SUMMARY" | "CANONICAL" | "AUDIT";

export type FinalizationDefect = {
  stage: FinalizationStage;
  code: string;
  message: string;
  packetIndex?: number;
  claimKeys: string[];
  evidenceKeys: string[];
  repairable: boolean;
};

class FinalizationError extends Error {
  constructor(readonly defects: FinalizationDefect[], readonly partial?: { coverage?: CoveragePlan; packets?: Array<Packet | undefined> }) {
    super(defects.map((defect) => `${defect.stage}: ${defect.message}`).join("; "));
  }
}

const auditSchema = z.object({
  status: z.enum(["PASSED", "REPAIR_REQUIRED"]),
  defects: z.array(z.object({
    severity: z.enum(["MATERIAL", "WARNING"]),
    code: z.string().min(1),
    message: z.string().min(1),
    stage: z.enum(["PACKET", "SUMMARY", "CANONICAL", "AUDIT"]).optional(),
    packetIndex: z.number().int().nonnegative().optional(),
    claimKeys: z.array(z.string().min(1)).max(100).default([]),
    evidenceKeys: z.array(z.string().min(1)).max(100).default([]),
  }).strict()).max(100),
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

function defect(stage: FinalizationStage, error: unknown, options: Partial<Omit<FinalizationDefect, "stage" | "message">> = {}): FinalizationError {
  if (error instanceof FinalizationError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new FinalizationError([{
    stage,
    code: `${stage}_VALIDATION_FAILED`,
    message,
    claimKeys: [],
    evidenceKeys: [],
    repairable: stage === "COVERAGE" || stage === "PACKET" || stage === "SUMMARY",
    ...options,
  }]);
}

function defectsFrom(error: unknown): FinalizationDefect[] {
  return error instanceof FinalizationError ? error.defects : [{
    stage: "CANONICAL",
    code: "FINALIZATION_FAILED",
    message: error instanceof Error ? error.message : String(error),
    claimKeys: [],
    evidenceKeys: [],
    repairable: false,
  }];
}

export function repairScope(defects: FinalizationDefect[]): "COVERAGE" | "PACKET" | "SUMMARY" | undefined {
  if (!defects.length || defects.some((item) => !item.repairable)) return undefined;
  const stages = new Set(defects.map((item) => item.stage));
  if (stages.size !== 1) return undefined;
  const [stage] = [...stages];
  if (stage === "COVERAGE" || stage === "SUMMARY") return stage;
  if (stage === "PACKET" && defects.length === 1 && defects[0]!.packetIndex !== undefined) return stage;
  return undefined;
}

export async function runPacketizedFinalization(input: Input): Promise<{ result: InvestigationResult; artifact: PacketFinalizationArtifact; compilerAttempts: 1 | 2; auditorAttempts: 1 | 2 }> {
  const { snapshot: authoritySnapshot } = await loadSourceAuthority(input.root, input.sourceStore);
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
  const buildCoverage = async (repairDefects: FinalizationDefect[]): Promise<CoveragePlan> => {
    try {
      const value = await promptJson("evidence-compiler", "Exhaustive coverage outline", COVERAGE_PROMPT_CONTRACT, {
        input: parsedInput,
        repairDefects: repairDefects.map(({ message }) => message),
      }, coveragePlanSchema, 0, { "source.excerpts": false, skill: false });
      return validateCoveragePlan(value, parsedInput as never);
    } catch (error) {
      throw defect("COVERAGE", error);
    }
  };

  const buildPacket = async (coverage: CoveragePlan, packetIndex: number, repairDefects: FinalizationDefect[], allowance: number): Promise<Packet> => {
    const packets = splitClaimPackets(coverage.claims, 5);
    try {
      const value = await promptJson("evidence-compiler", `Evidence packet ${packetIndex + 1}/${packets.length}`, PACKET_PROMPT_CONTRACT, {
        input: parsedInput,
        claimOutlines: packets[packetIndex],
        researchMemos: base.researchMemos,
        citedSources: base.citedSources,
        warnings,
        repairDefects: repairDefects.map(({ message }) => message),
      }, packetSchema, allowance, { "source.excerpts": true, skill: true });
      return await validatePacketEvidence(value, packets[packetIndex]!, input.sourceStore, allowedSourceRefs);
    } catch (error) {
      throw defect("PACKET", error, {
        packetIndex,
        claimKeys: packets[packetIndex]?.map(({ key }) => key) ?? [],
      });
    }
  };

  const buildPackets = async (coverage: CoveragePlan, repairDefects: FinalizationDefect[], existing?: Array<Packet | undefined>, repairPacketIndex?: number): Promise<Packet[]> => {
    const packets = splitClaimPackets(coverage.claims, 5);
    if (repairPacketIndex !== undefined) {
      if (!existing || existing.length !== packets.length || existing.some((packet, index) => index !== repairPacketIndex && !packet)) throw new FinalizationError([{
        stage: "PACKET",
        code: "PACKET_REPAIR_SCOPE_UNAVAILABLE",
        message: "A packet-local repair was requested without a complete valid packet set.",
        packetIndex: repairPacketIndex,
        claimKeys: packets[repairPacketIndex]?.map(({ key }) => key) ?? [],
        evidenceKeys: [],
        repairable: false,
      }]);
      const repaired = [...existing] as Array<Packet | undefined>;
      repaired[repairPacketIndex] = await buildPacket(coverage, repairPacketIndex, repairDefects, 15_000);
      return repaired as Packet[];
    }
    const packetAllowance = packets.length ? Math.floor((repairDefects.length ? 15_000 : 60_000) / packets.length) : 0;
    const packetResults: Array<Packet | undefined> = new Array(packets.length);
    const packetDefects: FinalizationDefect[] = [];
    let next = 0;
    const worker = async () => {
      while (true) {
        const index = next++;
        if (index >= packets.length) return;
        try {
          packetResults[index] = await buildPacket(coverage, index, repairDefects, packetAllowance);
        } catch (error) {
          packetDefects.push(...defectsFrom(error));
        }
      }
    };
    await Promise.all([worker(), worker()]);
    if (packetDefects.length) throw new FinalizationError(
      packetDefects.sort((left, right) => (left.packetIndex ?? 0) - (right.packetIndex ?? 0)),
      { packets: packetResults },
    );
    return packetResults as Packet[];
  };

  const buildSummary = async (coverage: CoveragePlan, packets: Packet[], repairDefects: FinalizationDefect[]) => {
    try {
      return await promptJson("evidence-compiler", "Summary and timeline", SUMMARY_TIMELINE_PROMPT_CONTRACT, {
        input: parsedInput,
        claims: packets.flatMap((packet) => packet.claims),
        evidence: packets.flatMap((packet) => packet.evidence),
        repairDefects: repairDefects.map(({ message }) => message),
      }, summaryTimelineOutputSchema, 0, { "source.excerpts": false, skill: false });
    } catch (error) {
      throw defect("SUMMARY", error);
    }
  };

  const assemble = async (coverage: CoveragePlan, packets: Packet[], summaryOutput: z.infer<typeof summaryTimelineOutputSchema>, repairDefects: FinalizationDefect[], compilerAttempt: 1 | 2): Promise<{ dossier: PacketDossier; result: InvestigationResult }> => {
    try {
      const dossier = mergePacketDossier(coverage, packets, summaryOutput.summary, summaryOutput.timeline, allowedSourceRefs);
      await writeAtomic(join(input.root, ".work/finalization/evidence-dossier.json"), `${JSON.stringify(dossier, null, 2)}\n`);
      await writeAtomic(join(input.root, ".work/finalization/evidence-dossier.md"), renderEvidenceDossierMarkdown(dossier));
      const result = await canonicalizeInvestigationResult(packetDossierToDraft(dossier), {
        run: provisionalRun,
        sourceStore: input.sourceStore,
        authoritySnapshot,
        compilerAttempts: compilerAttempt,
        auditorAttempts: 1,
        warnings,
        providerCalls: input.budget.snapshot().externalNetworkCalls,
      });
      return { dossier, result };
    } catch (error) {
      throw defect("CANONICAL", error);
    }
  };

  const compile = async (repairDefects: FinalizationDefect[], existingCoverage?: CoveragePlan, existingPackets?: Array<Packet | undefined>, repairPacketIndex?: number, compilerAttempt: 1 | 2 = 1): Promise<{ coverage: CoveragePlan; packets: Packet[]; current: { dossier: PacketDossier; result: InvestigationResult } }> => {
    const coverage = existingCoverage ?? await buildCoverage(repairDefects);
    let packets: Packet[];
    try {
      packets = await buildPackets(coverage, repairDefects, existingPackets, repairPacketIndex);
    } catch (error) {
      if (error instanceof FinalizationError) throw new FinalizationError(error.defects, { coverage, packets: error.partial?.packets });
      throw error;
    }
    let summary: z.infer<typeof summaryTimelineOutputSchema>;
    try {
      summary = await buildSummary(coverage, packets, repairDefects);
    } catch (error) {
      if (error instanceof FinalizationError) throw new FinalizationError(error.defects, { coverage, packets });
      throw error;
    }
    const current = await assemble(coverage, packets, summary, repairDefects, compilerAttempt);
    return { coverage, packets, current };
  };

  let compilerAttempts: 1 | 2 = 1;
  let auditorAttempts: 1 | 2 = 1;
  let repairUsed = false;
  let coverage: CoveragePlan | undefined;
  let packets: Array<Packet | undefined> | undefined;
  let current: { dossier: PacketDossier; result: InvestigationResult };
  if (reusablePacketDossier) {
    const dossier = reusablePacketDossier;
    reusablePacketDossier = undefined;
    try {
      current = {
        dossier,
        result: await canonicalizeInvestigationResult(packetDossierToDraft(dossier), {
          run: provisionalRun,
          sourceStore: input.sourceStore,
          authoritySnapshot,
          compilerAttempts: 1,
          auditorAttempts: 1,
          warnings,
          providerCalls: input.budget.snapshot().externalNetworkCalls,
        }),
      };
    } catch (error) {
      throw defect("CANONICAL", error);
    }
  } else {
    try {
      const compiled = await compile([]);
      coverage = compiled.coverage;
      packets = compiled.packets;
      current = compiled.current;
    } catch (error) {
      const defects = defectsFrom(error);
      if (error instanceof FinalizationError) {
        coverage = error.partial?.coverage;
        packets = error.partial?.packets;
      }
      const scope = repairScope(defects);
      if (!scope) throw error;
      repairUsed = true;
      compilerAttempts = 2;
      if (scope === "COVERAGE") {
        const compiled = await compile(defects, undefined, undefined, undefined, 2);
        coverage = compiled.coverage;
        packets = compiled.packets;
        current = compiled.current;
      } else if (scope === "PACKET" && coverage && packets && defects[0]!.packetIndex !== undefined) {
        const compiled = await compile(defects, coverage, packets, defects[0]!.packetIndex, 2);
        packets = compiled.packets;
        current = compiled.current;
      } else if (scope === "SUMMARY" && coverage && packets && packets.every((packet): packet is Packet => Boolean(packet))) {
        const completePackets = packets;
        const summary = await buildSummary(coverage, completePackets, defects);
        current = await assemble(coverage, completePackets, summary, defects, 2);
      } else {
        throw error;
      }
    }
  }

  const runAudit = async (title: string): Promise<FinalizationDefect[]> => {
    let audit: z.infer<typeof auditSchema>;
    try {
      audit = await promptJson("evidence-auditor", title, AUDITOR_PROMPT_CONTRACT, {
        input: parsedInput,
        dossier: current.dossier,
        result: resultForAudit(current.result, allowedSourceRefs),
        citedSources: base.citedSources,
      }, auditSchema, 30_000, { "source.excerpts": false, skill: false });
    } catch (error) {
      throw defect("AUDIT", error, { repairable: false });
    }
    const material = audit.defects.filter((item) => item.severity === "MATERIAL");
    if (audit.status === "PASSED" && material.length === 0) return [];
    if (audit.status !== "PASSED" && material.length === 0) {
      return [{ stage: "AUDIT", code: "AUDIT_SCOPE_MISSING", message: "Independent auditor requested repair without a material scoped defect.", claimKeys: [], evidenceKeys: [], repairable: false }];
    }
    return material.map((item) => ({
      stage: item.stage ?? "AUDIT",
      code: item.code,
      message: item.message,
      ...(item.packetIndex !== undefined ? { packetIndex: item.packetIndex } : {}),
      claimKeys: item.claimKeys,
      evidenceKeys: item.evidenceKeys,
      repairable: (item.stage === "PACKET" && item.packetIndex !== undefined) || item.stage === "SUMMARY",
    }));
  };

  const firstAuditDefects = await runAudit("Independent evidence audit");
  if (firstAuditDefects.length) {
    const scope = repairScope(firstAuditDefects);
    if (repairUsed || !scope || !coverage || !packets || packets.some((packet) => !packet)) {
      throw new FinalizationError(firstAuditDefects);
    }
    const completePackets = packets.filter((packet): packet is Packet => Boolean(packet));
    repairUsed = true;
    compilerAttempts = 2;
    if (scope === "PACKET" && firstAuditDefects[0]!.packetIndex !== undefined) {
      const repairedPackets = await buildPackets(coverage, firstAuditDefects, completePackets, firstAuditDefects[0]!.packetIndex);
      packets = repairedPackets;
      const summary = await buildSummary(coverage, repairedPackets, firstAuditDefects);
      current = await assemble(coverage, repairedPackets, summary, firstAuditDefects, 2);
    } else if (scope === "SUMMARY") {
      const summary = await buildSummary(coverage, completePackets, firstAuditDefects);
      current = await assemble(coverage, completePackets, summary, firstAuditDefects, 2);
    } else {
      throw new FinalizationError(firstAuditDefects);
    }
    const secondAuditDefects = await runAudit("Independent evidence audit after scoped repair");
    auditorAttempts = 2;
    if (secondAuditDefects.length) throw new FinalizationError(secondAuditDefects);
  }

  if (input.dossierCheckpointConfig) {
    await writePacketDossierCheckpoint(input.root, { dossier: current.dossier, config: input.dossierCheckpointConfig });
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
    authoritySnapshot,
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
