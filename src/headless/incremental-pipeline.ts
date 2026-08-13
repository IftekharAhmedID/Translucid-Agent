import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { z } from "zod";

import { finalizerModelDefinition } from "../core/model-catalog.ts";
import { extractStructuredOutput } from "../agent/structured-output.ts";
import { HANDOFF_MANIFEST_PATH, writeResearchCheckpoint } from "./checkpoint.ts";
import {
  buildFinalizerContext,
  describeSdkError,
  nativeFinalizerPromptPayload,
  type AssistantMessage,
  type FinalizationPipelineInput,
} from "./finalization-controller.ts";
import { canonicalizeInvestigationResult, investigationDraftSchema, type InvestigationDraft, type InvestigationResult } from "./result-contract.ts";
import { summaryTimelineOutputSchema } from "./packet-dossier.ts";
import { promptWithPayload, CLAIM_BATCH_PROMPT_CONTRACT, EVIDENCE_LINK_BATCH_PROMPT_CONTRACT, V4_AUDITOR_PROMPT_CONTRACT } from "./prompt-contracts.ts";
import { atomicJson, claimBatchSchema, evidenceBatchSchema, readJsonIfPresent, validateClaimBatch, validateEvidenceBatch, type ExcerptRecord, type ValidatedClaim, type ValidatedExclusion } from "./incremental-finalization.ts";
import { buildLineCatalog, lineCatalogSchema, type LineCatalog } from "./line-catalog.ts";

const directory = "/workspace/case";
const stageDirectory = ".work/finalization/v4";
const provenanceDirectory = "provenance/finalization";
const auditSchema = z.object({
  status: z.enum(["PASSED", "REPAIR_REQUIRED"]),
  defects: z.array(z.object({
    severity: z.enum(["MATERIAL", "WARNING"]),
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(4_000),
    stage: z.enum(["CLAIM", "EVIDENCE", "SUMMARY", "AUDIT"]).default("AUDIT"),
    claimKeys: z.array(z.string().min(1)).max(100).default([]),
    evidenceKeys: z.array(z.string().min(1)).max(100).default([]),
    repairable: z.boolean().default(false),
  }).strict()).max(100),
}).strict();

type V4Input = FinalizationPipelineInput;
type V4Evidence = InvestigationDraft["evidence"][number];
type V4Claim = InvestigationDraft["claims"][number];

export async function publishFinalizationProvenance(root: string): Promise<void> {
  await cp(join(root, stageDirectory), join(root, provenanceDirectory), { recursive: true, force: true });
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function byteDigest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fileDigest(path: string): Promise<string> {
  return byteDigest(await readFile(path));
}

async function committedFileHashes(root: string): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const directoryName of ["claims", "evidence"]) {
    const directoryPath = join(root, stageDirectory, directoryName);
    const entries = await readdir(directoryPath, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
    for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".json")).sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = `${directoryName}/${entry.name}`;
      output[relativePath] = await fileDigest(join(directoryPath, entry.name));
    }
  }
  for (const name of ["line-catalog.json", "coverage.json", "summary.json", "audit.json"]) {
    try {
      output[name] = await fileDigest(join(root, stageDirectory, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return output;
}

function unwrap<T>(result: { data?: T; error?: unknown }, action: string): T {
  if (result.error || result.data === undefined) throw new Error(`${action} failed: ${describeSdkError(result.error ?? "missing data")}`);
  return result.data;
}

function providerFor(model: string): string {
  try { return finalizerModelDefinition(model).providerId; }
  catch { return "translucid"; }
}

function lineWindow(catalog: LineCatalog, unresolved: Set<string>): LineCatalog["lines"] {
  const output: LineCatalog["lines"] = [];
  let characters = 0;
  for (const line of catalog.lines) {
    if (line.layout !== "SEMANTIC" || !unresolved.has(line.id)) continue;
    if (output.length >= 5 || (output.length > 0 && characters + line.text.length > 8_000)) break;
    output.push(line);
    characters += line.text.length;
  }
  return output;
}

function sourceRefsFromMetadata(sources: Array<Record<string, unknown>>): Set<string> {
  return new Set(sources.flatMap((source) => {
    if (typeof source.ref !== "string") return [];
    const authority = typeof source.sourceAuthority === "string" ? source.sourceAuthority : "CONTEXT";
    return authority === "CONTEXT" || authority === "DISCOVERY_ONLY" ? [] : [source.ref];
  }));
}

function claimDraft(claim: ValidatedClaim, evidence: V4Evidence[], explanation?: string, facetNotes?: Map<string, string>): V4Claim {
  return {
    key: claim.claimKey,
    category: claim.category,
    statement: claim.statement,
    materiality: claim.materiality,
    sourceSpan: { ...claim.sourceSpan },
    explanation: explanation ?? (evidence.length ? evidence[0]!.exactQuote : "No eligible immutable source resolved this reported assertion."),
    facets: claim.facets.map((facet) => ({ key: facet.key, label: facet.label, materiality: facet.materiality, status: "UNRESOLVED", note: facetNotes?.get(facet.key) ?? "Awaiting evidence linking." })),
  };
}

async function writeStage(root: string, name: string, value: unknown): Promise<void> {
  await atomicJson(join(root, stageDirectory, name), value);
}

async function readStageRecords<T>(root: string, directoryName: string): Promise<T[]> {
  const directoryPath = join(root, stageDirectory, directoryName);
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const records: T[] = [];
  for (const entry of entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).sort((left, right) => left.name.localeCompare(right.name))) {
    const record = await readJsonIfPresent(join(directoryPath, entry.name), (value) => value as T);
    if (record) records.push(record);
  }
  return records;
}

async function readStageEntries<T>(root: string, directoryName: string): Promise<Array<{ name: string; value: T }>> {
  const directoryPath = join(root, stageDirectory, directoryName);
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const records: Array<{ name: string; value: T }> = [];
  for (const entry of entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).sort((left, right) => left.name.localeCompare(right.name))) {
    const value = await readJsonIfPresent(join(directoryPath, entry.name), (raw) => raw as T);
    if (value !== undefined) records.push({ name: entry.name, value });
  }
  return records;
}

export async function runIncrementalFinalization(input: V4Input): Promise<InvestigationResult> {
  const client = createOpencodeClient({ baseUrl: input.handle.openCodeUrl, headers: input.handle.accessHeaders, throwOnError: false });
  const base = await buildFinalizerContext(input.root, input.sourceStore, input.researchMemos);
  const warnings = [...input.warnings, ...base.warnings];
  if (input.researchCheckpointConfig) {
    await input.budget.flush();
    await writeResearchCheckpoint(input.root, { warnings, budget: input.budget.snapshot(), config: input.researchCheckpointConfig });
  }
  const allowedSourceRefs = sourceRefsFromMetadata(base.citedSources);
  const parsedInput = base.input as Parameters<typeof buildLineCatalog>[0];
  const builtCatalog = buildLineCatalog(parsedInput);
  const storedCatalog = await readJsonIfPresent(join(input.root, stageDirectory, "line-catalog.json"), (value) => lineCatalogSchema.parse(value));
  if (storedCatalog && storedCatalog.fingerprint !== builtCatalog.fingerprint) throw new Error("Finalization line catalog changed since the checkpoint was created.");
  const catalog = storedCatalog ?? builtCatalog;
  const root = input.root;
  const v4Root = join(root, stageDirectory);
  await mkdir(join(v4Root, "claims"), { recursive: true, mode: 0o700 });
  await mkdir(join(v4Root, "evidence"), { recursive: true, mode: 0o700 });
  if (!storedCatalog) await writeStage(root, "line-catalog.json", catalog);
  const handoffResearch = await readJsonIfPresent(join(root, HANDOFF_MANIFEST_PATH), (value) => value as { research?: { fingerprint?: string } });
  const finalizerConfiguration = {
    implementation: "incremental-finalizer-v4",
    researchFingerprint: handoffResearch?.research?.fingerprint ?? input.inputSha256,
    lineCatalogFingerprint: catalog.fingerprint,
    claimSchemaHash: digest(z.toJSONSchema(claimBatchSchema)),
    evidenceSchemaHash: digest(z.toJSONSchema(evidenceBatchSchema)),
    promptHash: digest([CLAIM_BATCH_PROMPT_CONTRACT, EVIDENCE_LINK_BATCH_PROMPT_CONTRACT, V4_AUDITOR_PROMPT_CONTRACT]),
    compilerModel: input.compilerModel,
    auditorModel: input.auditorModel,
    runtimeManifestHash: input.handle.manifestHash,
  };
  const finalizerFingerprint = digest(finalizerConfiguration);
  const storedManifest = await readJsonIfPresent(join(v4Root, "manifest.json"), (value) => value as { fingerprint?: string; files?: Record<string, string> });
  if (storedManifest?.fingerprint && storedManifest.fingerprint !== finalizerFingerprint) throw new Error("Finalization checkpoint configuration changed; start a new finalization checkpoint.");
  if (storedManifest?.files) {
    for (const [relativePath, expectedHash] of Object.entries(storedManifest.files)) {
      const actualHash = await fileDigest(join(v4Root, relativePath));
      if (actualHash !== expectedHash) throw new Error(`Finalization checkpoint hash mismatch for ${relativePath}.`);
    }
  }
  await writeStage(root, "manifest.json", {
    schemaVersion: 2,
    implementation: "incremental-finalizer-v4",
    fingerprint: finalizerFingerprint,
    configuration: finalizerConfiguration,
    files: storedManifest?.files ?? {},
  });

  const promptSession = async (agent: "resume-claim-compiler" | "evidence-linker" | "evidence-compiler" | "evidence-auditor", title: string, payload: Record<string, unknown>, allowance: number): Promise<AssistantMessage> => {
    const model = agent === "evidence-auditor" ? input.auditorModel : input.compilerModel;
    const providerID = providerFor(model);
    const session = unwrap(await client.session.create({ directory, title, agent, model: { id: model, providerID, variant: "medium" } }, { signal: input.signal }), `${agent} session creation`);
    input.registerExcerptAllowance(session.id, allowance);
    const response = unwrap(await client.session.prompt({ sessionID: session.id, directory, agent, model: { providerID, modelID: model }, variant: "medium", ...payload }, { signal: input.signal }), `${agent} prompt`);
    return response as unknown as AssistantMessage;
  };

  const promptJson = async <T>(agent: "resume-claim-compiler" | "evidence-linker" | "evidence-compiler" | "evidence-auditor", title: string, contract: string, payload: unknown, schema: z.ZodType<T>, allowance: number, tools: Record<string, boolean>): Promise<T> => {
    const response = await promptSession(agent, title, { tools, ...nativeFinalizerPromptPayload(promptWithPayload(contract, payload), schema) }, allowance);
    return schema.parse(extractStructuredOutput(response));
  };

  const existingClaims = await readStageRecords<ValidatedClaim>(root, "claims");
  const existingEvidenceEntries = await readStageEntries<V4Evidence[]>(root, "evidence");
  const existingEvidence = existingEvidenceEntries.map(({ value }) => value);
  const completedEvidenceClaims = new Set(existingEvidenceEntries.map(({ name }) => name.replace(/\.json$/u, "")));
  const claims: ValidatedClaim[] = [...existingClaims];
  const storedCoverage = await readJsonIfPresent(join(root, stageDirectory, "coverage.json"), (value) => value as { exclusions?: ValidatedExclusion[] });
  const exclusions: ValidatedExclusion[] = storedCoverage?.exclusions ? [...storedCoverage.exclusions] : [];
  const dispositions = new Set<string>(claims.flatMap(({ lineIds }) => lineIds));
  const semanticLines = catalog.lines.filter(({ layout }) => layout === "SEMANTIC");
  let claimNumber = claims.length;
  while (semanticLines.some(({ id }) => !dispositions.has(id))) {
    input.signal.throwIfAborted();
    const unresolved = new Set(semanticLines.filter(({ id }) => !dispositions.has(id)).map(({ id }) => id));
    const window = lineWindow(catalog, unresolved);
    if (!window.length) throw new Error("Claim scheduler cannot make progress.");
    const value = await promptJson("resume-claim-compiler", `Claim batch ${claimNumber + 1}`, CLAIM_BATCH_PROMPT_CONTRACT, {
      lineWindow: window,
      acceptedClaims: claims.map((claim) => ({ claimKey: claim.claimKey, statement: claim.statement, facets: claim.facets.map(({ key, label }) => ({ key, label })) })).slice(-20),
    }, claimBatchSchema, 0, { "source.excerpts": false, skill: false });
    const validated = validateClaimBatch(value, catalog, window.map(({ id }) => id), "C", claimNumber);
    claims.push(...validated.claims);
    exclusions.push(...validated.exclusions);
    for (const claim of validated.claims) for (const lineId of claim.lineIds) dispositions.add(lineId);
    for (const exclusion of validated.exclusions) for (const lineId of exclusion.lineIds) dispositions.add(lineId);
    await Promise.all(validated.claims.map((claim) => atomicJson(join(v4Root, "claims", `${claim.claimKey}.json`), claim)));
    await writeStage(root, "coverage.json", { semanticLineIds: semanticLines.map(({ id }) => id), exclusions, claimedLineIds: [...dispositions] });
    claimNumber = claims.length;
  }

  const excerpts = new Map<string, ExcerptRecord>();
  for (const sourceRef of allowedSourceRefs) {
    const queries = [...new Set(claims.flatMap((claim) => {
      const words = claim.statement.split(/\s+/u).map((word) => word.replace(/[^\p{L}\p{N}-]/gu, "")).filter((word) => word.length > 2);
      return ["text", "title", "records", claim.statement, ...claim.facets.map(({ label }) => label), words.slice(0, 3).join(" "), words.slice(1, 4).join(" ")];
    }))].filter(Boolean).slice(0, 12);
    if (!queries.length) continue;
    const result = await input.sourceStore.excerpts({ sourceRef, queries, maxCharacters: 30_000 });
    for (const excerpt of result.excerpts) excerpts.set(excerpt.ref, { ...excerpt, sourceRef });
  }

  const evidenceByClaim = new Map<string, V4Evidence>();
  for (const record of existingEvidence.flat()) evidenceByClaim.set(record.key, record);
  let evidence: V4Evidence[] = [...evidenceByClaim.values()];
  const explanations = new Map<string, string>();
  const facetNotesByClaim = new Map<string, Map<string, string>>();
  const materializeEvidence = async (item: z.infer<typeof evidenceBatchSchema>["claims"][number], claim: ValidatedClaim): Promise<V4Evidence[]> => {
    const facetKeys = new Set(claim.facets.map(({ key }) => key));
    const records: V4Evidence[] = [];
    for (const edge of item.edges) {
      const excerpt = excerpts.get(edge.excerptRef);
      if (!excerpt || !allowedSourceRefs.has(excerpt.sourceRef)) continue;
      const exact = await input.sourceStore.verifyExactQuote({ sourceRef: excerpt.sourceRef, path: excerpt.path, exactQuote: excerpt.text });
      if (!exact.valid) throw new Error(`Evidence excerpt ${edge.excerptRef} is not an exact immutable quote.`);
      const validFacetKeys = edge.facetKeys.filter((key) => facetKeys.has(key));
      if (!validFacetKeys.length) continue;
      const nextNumber = Math.max(0, ...evidence.map(({ key }) => Number(key.slice(1)))) + records.length + 1;
      records.push({ key: `E${String(nextNumber).padStart(3, "0")}`, claimKey: claim.claimKey, facetKeys: validFacetKeys, relation: edge.relation, sourceRef: excerpt.sourceRef, exactQuote: excerpt.text, sourceLocation: { path: excerpt.path } });
    }
    return records;
  };
  const linkEvidenceForClaims = async (assigned: ValidatedClaim[], title: string, allowance: number): Promise<void> => {
    const response = await promptJson("evidence-linker", title, EVIDENCE_LINK_BATCH_PROMPT_CONTRACT, {
      claims: assigned.map((claim) => ({ claimKey: claim.claimKey, statement: claim.statement, facets: claim.facets.map(({ key, label, materiality }) => ({ key, label, materiality })) })),
      citedSources: base.citedSources,
      excerptCandidates: [...excerpts.values()].slice(0, 100),
    }, evidenceBatchSchema, allowance, { "source.excerpts": true, skill: true });
    const validated = validateEvidenceBatch(response, assigned.map((claim) => ({ claimKey: claim.claimKey, facets: claim.facets })), excerpts);
    for (const item of validated.claims) {
      const claim = assigned.find(({ claimKey }) => claimKey === item.claimId)!;
      explanations.set(item.claimId, item.explanation);
      facetNotesByClaim.set(item.claimId, new Map(item.facetNotes.map(({ facetKey, note }) => [facetKey, note])));
      const records = await materializeEvidence(item, claim);
      evidence.push(...records);
      await atomicJson(join(v4Root, "evidence", `${claim.claimKey}.json`), records);
    }
  };
  for (let index = 0; index < claims.length; index += 5) {
    const assigned = claims.slice(index, index + 5);
    const pending = assigned.filter(({ claimKey }) => !completedEvidenceClaims.has(claimKey));
    if (!pending.length) continue;
    await linkEvidenceForClaims(pending, `Evidence batch ${index / 5 + 1}`, 30_000);
  }

  let draftClaims = claims.map((claim) => claimDraft(claim, evidence.filter(({ claimKey }) => claimKey === claim.claimKey), explanations.get(claim.claimKey), facetNotesByClaim.get(claim.claimKey)));
  const compileSummary = async () => {
    const value = await promptJson("evidence-compiler", "Incremental summary and timeline", "MODE: SUMMARY_TIMELINE", {
      input: parsedInput,
      claims: draftClaims.map((claim) => ({ claimKey: claim.key, statement: claim.statement, facets: claim.facets.map(({ key, label, materiality }) => ({ key, label, materiality })) })),
      evidence,
    }, summaryTimelineOutputSchema, 0, { "source.excerpts": false, skill: false });
    await writeStage(root, "summary.json", value);
    return value;
  };
  let summary = await compileSummary();
  let draft: InvestigationDraft = investigationDraftSchema.parse({ ...summary, claims: draftClaims, evidence });
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
  let compilerAttempts: 1 | 2 = 1;
  const auditOnce = async () => {
    const value = await promptJson("evidence-auditor", "Incremental independent audit", V4_AUDITOR_PROMPT_CONTRACT, { input: parsedInput, lineCatalog: catalog, exclusions, claims: draftClaims, evidence, summary }, auditSchema, 30_000, { "source.excerpts": true, skill: false });
    await writeStage(root, "audit.json", value);
    return value;
  };
  await canonicalizeInvestigationResult(draft, { run: provisionalRun, sourceStore: input.sourceStore, compilerAttempts, auditorAttempts: 1, warnings, providerCalls: input.budget.snapshot().externalNetworkCalls, strictSemanticFacetChecks: false });
  let audit = await auditOnce();
  let material = audit.defects.filter(({ severity }) => severity === "MATERIAL");
  if (audit.status !== "PASSED" || material.length) {
    const defect = material.length === 1 ? material[0] : undefined;
    const targetClaimKey = defect?.claimKeys.length === 1 ? defect.claimKeys[0] : undefined;
    if (!defect || !defect.repairable || (defect.stage !== "SUMMARY" && defect.stage !== "CLAIM" && defect.stage !== "EVIDENCE") || (defect.stage !== "SUMMARY" && !targetClaimKey) || defect.claimKeys.length > 1 || defect.evidenceKeys.length > 1) {
      throw new Error(`Incremental finalization audit failed: ${material.map(({ message }) => message).join("; ") || "unscoped audit defect"}`);
    }
    if (defect.stage === "CLAIM" && targetClaimKey) {
      const claimIndex = claims.findIndex(({ claimKey }) => claimKey === targetClaimKey);
      const original = claims[claimIndex];
      if (!original) throw new Error(`Audit repair references unknown claim ${targetClaimKey}.`);
      const match = /^C(\d+)$/u.exec(targetClaimKey);
      if (!match) throw new Error(`Audit repair references malformed claim ${targetClaimKey}.`);
      const repaired = validateClaimBatch(await promptJson("resume-claim-compiler", `Repair ${targetClaimKey}`, CLAIM_BATCH_PROMPT_CONTRACT, { repairClaimKey: targetClaimKey, lineWindow: catalog.lines.filter(({ id }) => original.lineIds.includes(id)), acceptedClaims: claims.filter(({ claimKey }) => claimKey !== targetClaimKey).map(({ claimKey, statement, facets }) => ({ claimKey, statement, facets: facets.map(({ key, label }) => ({ key, label })) })) }, claimBatchSchema, 0, { "source.excerpts": false, skill: false }), catalog, original.lineIds, "C", Number(match[1]) - 1);
      if (repaired.claims.length !== 1 || repaired.exclusions.length || repaired.deferredLineIds.length || new Set(repaired.claims[0]!.lineIds).size !== new Set(original.lineIds).size || repaired.claims[0]!.lineIds.some((lineId) => !original.lineIds.includes(lineId))) throw new Error(`Audit repair for ${targetClaimKey} attempted to change immutable line ownership.`);
      claims[claimIndex] = repaired.claims[0]!;
      await atomicJson(join(v4Root, "claims", `${targetClaimKey}.json`), repaired.claims[0]);
      evidence = evidence.filter(({ claimKey }) => claimKey !== targetClaimKey);
      await rm(join(v4Root, "evidence", `${targetClaimKey}.json`), { force: true });
      completedEvidenceClaims.delete(targetClaimKey);
      await linkEvidenceForClaims([repaired.claims[0]!], `Repair evidence for ${targetClaimKey}`, 10_000);
    } else if (defect.stage === "EVIDENCE" && targetClaimKey) {
      const target = claims.find(({ claimKey }) => claimKey === targetClaimKey);
      if (!target) throw new Error(`Audit repair references unknown claim ${targetClaimKey}.`);
      evidence = evidence.filter(({ claimKey }) => claimKey !== targetClaimKey);
      await rm(join(v4Root, "evidence", `${targetClaimKey}.json`), { force: true });
      completedEvidenceClaims.delete(targetClaimKey);
      await linkEvidenceForClaims([target], `Repair evidence for ${targetClaimKey}`, 10_000);
    }
    compilerAttempts = 2;
    draftClaims = claims.map((claim) => claimDraft(claim, evidence.filter(({ claimKey }) => claimKey === claim.claimKey), explanations.get(claim.claimKey), facetNotesByClaim.get(claim.claimKey)));
    summary = await compileSummary();
    draft = investigationDraftSchema.parse({ ...summary, claims: draftClaims, evidence });
    await canonicalizeInvestigationResult(draft, { run: provisionalRun, sourceStore: input.sourceStore, compilerAttempts, auditorAttempts: 1, warnings, providerCalls: input.budget.snapshot().externalNetworkCalls, strictSemanticFacetChecks: false });
    audit = await auditOnce();
    material = audit.defects.filter(({ severity }) => severity === "MATERIAL");
    if (audit.status !== "PASSED" || material.length) throw new Error(`Incremental finalization audit failed after targeted repair: ${material.map(({ message }) => message).join("; ") || "unscoped audit defect"}`);
  }
  await input.budget.flush();
  const stats = await input.sourceStore.requestStats();
  const final = await canonicalizeInvestigationResult(draft, {
    run: { ...provisionalRun, finishedAt: new Date().toISOString(), budgets: { modelUsd: input.budget.snapshot().modelUsd, providerUsd: input.budget.snapshot().providerUsd, externalNetworkCalls: input.budget.snapshot().externalNetworkCalls } },
    sourceStore: input.sourceStore,
    compilerAttempts,
    auditorAttempts: 1,
    warnings,
    providerCalls: stats.providerCalls,
    cacheHits: stats.cacheHits,
    strictSemanticFacetChecks: false,
  });
  await writeStage(root, "manifest.json", {
    schemaVersion: 2,
    implementation: "incremental-finalizer-v4",
    fingerprint: finalizerFingerprint,
    configuration: finalizerConfiguration,
    files: await committedFileHashes(root),
  });
  input.onProgress?.(`Incremental finalization audit passed with ${final.claims.length} claims and ${final.evidence.length} evidence items.`);
  return final;
}
