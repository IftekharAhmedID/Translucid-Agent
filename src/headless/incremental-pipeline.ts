import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { z } from "zod";

import { extractMarkedJson, structuredOutputRecovery } from "../agent/structured-output.ts";
import { facetEvidenceCompatible } from "../core/evidence-fit.ts";
import { finalizerModelDefinition } from "../core/model-catalog.ts";
import { HANDOFF_MANIFEST_PATH, writeResearchCheckpoint } from "./checkpoint.ts";
import {
  buildFinalizerContext,
  describeSdkError,
  finalizerPromptPayload,
  finalizerRepairPayload,
  type AssistantMessage,
  type FinalizationPipelineInput,
} from "./finalization-controller.ts";
import {
  atomicJson,
  claimBatchSchema,
  evidenceJudgmentSchema,
  invalidatedFinalizationStages,
  v5StageManifestSchema,
  v5AuditSchema,
  readJsonIfPresent,
  validatedClaimSchema,
  validateClaimBatchRecords,
  validateEvidenceJudgment,
  type EvidenceJudgment,
  type ExcerptRecord,
  type ValidatedClaim,
  type ValidatedExclusion,
  type V5Audit,
  type V5StageManifest,
} from "./incremental-finalization.ts";
import { buildLineCatalog, lineCatalogSchema, type LineCatalog } from "./line-catalog.ts";
import { summaryTimelineOutputSchema } from "./packet-dossier.ts";
import { CLAIM_BATCH_PROMPT_CONTRACT, EVIDENCE_JUDGE_PROMPT_CONTRACT, promptWithPayload, SUMMARY_TIMELINE_PROMPT_CONTRACT, V5_AUDITOR_PROMPT_CONTRACT } from "./prompt-contracts.ts";
import { canonicalizeInvestigationResult, investigationDraftSchema, type InvestigationDraft, type InvestigationResult } from "./result-contract.ts";
import { loadSourceAuthority, OFFICIAL_DOMAIN_REGISTRY_PATH } from "./source-authority.ts";
import type { StoredExcerptCandidates } from "./source-store.ts";

const directory = "/workspace/case";
const stageDirectory = ".work/finalization/v5";
const provenanceDirectory = "provenance/finalization";
const excerptRecordSchema = z.object({
  ref: z.string().regex(/^X[a-f0-9]{64}$/),
  sourceRef: z.string().regex(/^S[1-9]\d*$/),
  path: z.string().min(1),
  offsetStart: z.number().int().nonnegative(),
  offsetEnd: z.number().int().positive(),
  text: z.string().min(1).max(1_000),
}).strict();
const candidateSetSchema = z.object({
  candidatesByFacet: z.record(z.string(), z.array(excerptRecordSchema).max(8)),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  totalCharacters: z.number().int().nonnegative().max(16_000),
}).strict();

type V5Input = FinalizationPipelineInput;
type V5Evidence = InvestigationDraft["evidence"][number];
type V5Claim = InvestigationDraft["claims"][number];
type Audit = V5Audit;

export async function publishFinalizationProvenance(root: string): Promise<void> {
  await cp(join(root, stageDirectory), join(root, provenanceDirectory), { recursive: true, force: true });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonicalize(child)]));
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

async function fileDigest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
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
  for (const name of ["line-catalog.json", "coverage.json", "source-authority-snapshot.json", "summary.json", "audit.json"]) {
    try { output[name] = await fileDigest(join(root, stageDirectory, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
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

function lineWindow(catalog: LineCatalog, unresolved: Set<string>): { contextLines: LineCatalog["lines"]; assignedLines: LineCatalog["lines"] } {
  const semantic = catalog.lines.filter(({ layout }) => layout === "SEMANTIC");
  const first = semantic.findIndex(({ id }) => unresolved.has(id));
  if (first < 0) return { contextLines: [], assignedLines: [] };
  const assignedLines: LineCatalog["lines"] = [];
  let characters = 0;
  for (const line of semantic.slice(first)) {
    if (!unresolved.has(line.id)) continue;
    if (assignedLines.length >= 12 || (assignedLines.length > 0 && characters + line.text.length > 8_000)) break;
    assignedLines.push(line);
    characters += line.text.length;
  }
  return { contextLines: semantic.slice(Math.max(0, first - 2), first), assignedLines };
}

function assistantText(message: AssistantMessage): string {
  return message.parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("").trim();
}

function claimDraft(claim: ValidatedClaim, evidence: V5Evidence[], judgment?: EvidenceJudgment): V5Claim {
  const reasonByFacet = new Map(judgment?.facets.map((facet) => {
    const useful = facet.candidates.find(({ relation }) => relation !== "IRRELEVANT") ?? facet.candidates[0];
    return [facet.facetKey, useful?.reason ?? "No eligible immutable source resolved this facet."];
  }) ?? []);
  return {
    key: claim.claimKey,
    category: claim.category,
    statement: claim.statement,
    materiality: claim.materiality,
    sourceSpan: { ...claim.sourceSpan },
    explanation: `Evidence relations: ${evidence.filter(({ relation }) => relation === "SUPPORTS").length} supporting, ${evidence.filter(({ relation }) => relation === "CONTRADICTS").length} contradicting. Judgment: ${[...reasonByFacet.values()].join(" ")}`,
    facets: claim.facets.map((facet) => ({ key: facet.key, label: facet.label, materiality: facet.materiality, status: "UNRESOLVED", note: reasonByFacet.get(facet.key) ?? "No eligible immutable source resolved this facet." })),
  };
}

async function readStageRecords<T>(root: string, directoryName: string, parse: (value: unknown) => T): Promise<T[]> {
  const directoryPath = join(root, stageDirectory, directoryName);
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const records: T[] = [];
  for (const entry of entries.filter((item) => item.isFile() && /^C\d+\.json$/u.test(item.name)).sort((left, right) => left.name.localeCompare(right.name))) {
    const record = await readJsonIfPresent(join(directoryPath, entry.name), parse);
    if (record) records.push(record);
  }
  return records;
}

export async function runIncrementalFinalization(input: V5Input): Promise<InvestigationResult> {
  const client = createOpencodeClient({ baseUrl: input.handle.openCodeUrl, headers: input.handle.accessHeaders, throwOnError: false });
  const base = await buildFinalizerContext(input.root, input.sourceStore, input.researchMemos);
  const warnings = [...input.warnings, ...base.warnings];
  if (input.researchCheckpointConfig) {
    await input.budget.flush();
    await writeResearchCheckpoint(input.root, { warnings, budget: input.budget.snapshot(), config: input.researchCheckpointConfig });
  }
  const root = input.root;
  const sources = await input.sourceStore.list();
  const { registry: officialDomainRegistry, snapshot: sourceAuthority } = await loadSourceAuthority(root, input.sourceStore);
  const v5Root = join(root, stageDirectory);
  const parsedInput = base.input as Parameters<typeof buildLineCatalog>[0];
  const builtCatalog = buildLineCatalog(parsedInput);
  const handoffResearch = await readJsonIfPresent(join(root, HANDOFF_MANIFEST_PATH), (value) => value as { research?: { fingerprint?: string } });
  const claimsConfiguration = {
    implementation: "incremental-finalizer-v5",
    researchFingerprint: handoffResearch?.research?.fingerprint ?? input.inputSha256,
    inputSha256: input.inputSha256,
    lineCatalogFingerprint: builtCatalog.fingerprint,
    schemaHash: digest(z.toJSONSchema(claimBatchSchema)),
    promptHash: digest(CLAIM_BATCH_PROMPT_CONTRACT),
    compilerModel: input.compilerModel,
    runtimeManifestHash: input.handle.manifestHash,
  };
  const claimsFingerprint = digest(claimsConfiguration);
  let storedManifest = await readJsonIfPresent(join(v5Root, "manifest.json"), (value) => v5StageManifestSchema.parse(value));
  if (storedManifest?.stages.claims?.fingerprint && storedManifest.stages.claims.fingerprint !== claimsFingerprint) {
    await rm(v5Root, { recursive: true, force: true });
    storedManifest = undefined;
  }
  if (storedManifest?.files) {
    const invalidFiles: string[] = [];
    for (const [relativePath, expectedHash] of Object.entries(storedManifest.files)) {
      try { if (await fileDigest(join(v5Root, relativePath)) !== expectedHash) invalidFiles.push(relativePath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") invalidFiles.push(relativePath); else throw error; }
    }
    if (invalidFiles.includes("line-catalog.json")) {
      await rm(v5Root, { recursive: true, force: true });
      storedManifest = undefined;
    } else if (invalidFiles.some((path) => path.startsWith("claims/"))) {
      const firstInvalid = Math.min(...invalidFiles.filter((path) => path.startsWith("claims/")).map((path) => Number(path.match(/C(\d+)\.json$/u)?.[1] ?? 1)));
      const entries = await readdir(join(v5Root, "claims"), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
      await Promise.all(entries.filter((entry) => entry.isFile() && Number(entry.name.match(/^C(\d+)\.json$/u)?.[1] ?? 0) >= firstInvalid).map((entry) => rm(join(v5Root, "claims", entry.name), { force: true })));
      await rm(join(v5Root, "coverage.json"), { force: true });
      await rm(join(v5Root, "evidence"), { recursive: true, force: true });
      await rm(join(v5Root, "summary.json"), { force: true });
      await rm(join(v5Root, "audit.json"), { force: true });
      delete storedManifest.stages.evidence;
      delete storedManifest.stages.summary;
      delete storedManifest.stages.audit;
    } else {
      if (invalidFiles.includes("coverage.json")) await rm(join(v5Root, "coverage.json"), { force: true });
      if (invalidFiles.includes("source-authority-snapshot.json")) await rm(join(v5Root, "source-authority-snapshot.json"), { force: true });
      for (const path of invalidFiles.filter((value) => value.startsWith("evidence/"))) {
        await rm(join(v5Root, path), { force: true });
        if (path.endsWith(".candidates.json")) await rm(join(v5Root, path.replace(".candidates.json", ".judgment.json")), { force: true });
      }
      if (invalidFiles.some((path) => path.startsWith("evidence/") || path === "summary.json")) {
        await rm(join(v5Root, "summary.json"), { force: true });
        await rm(join(v5Root, "audit.json"), { force: true });
        delete storedManifest.stages.summary;
        delete storedManifest.stages.audit;
      } else if (invalidFiles.includes("audit.json")) {
        await rm(join(v5Root, "audit.json"), { force: true });
        delete storedManifest.stages.audit;
      }
    }
  }
  await mkdir(join(v5Root, "claims"), { recursive: true, mode: 0o700 });
  await mkdir(join(v5Root, "evidence"), { recursive: true, mode: 0o700 });
  await mkdir(join(v5Root, "attempts"), { recursive: true, mode: 0o700 });
  const storedCatalog = await readJsonIfPresent(join(v5Root, "line-catalog.json"), (value) => lineCatalogSchema.parse(value));
  if (storedCatalog && storedCatalog.fingerprint !== builtCatalog.fingerprint) throw new Error("Finalization line catalog changed since the V5 checkpoint was created.");
  const catalog = storedCatalog ?? builtCatalog;
  if (!storedCatalog) await atomicJson(join(v5Root, "line-catalog.json"), catalog);
  await atomicJson(join(root, OFFICIAL_DOMAIN_REGISTRY_PATH), officialDomainRegistry);
  await atomicJson(join(v5Root, "source-authority-snapshot.json"), sourceAuthority);
  const eligibleSourceRefs = new Set(sourceAuthority.sources.filter(({ effectiveAuthority }) => !new Set(["CONTEXT", "DISCOVERY_ONLY"]).has(effectiveAuthority)).map(({ sourceRef }) => sourceRef));
  const manifest: V5StageManifest = storedManifest ?? { schemaVersion: 3, implementation: "incremental-finalizer-v5", stages: {}, files: {} };
  manifest.stages.claims = { fingerprint: claimsFingerprint, configuration: claimsConfiguration };
  const persistManifest = async () => {
    manifest.files = await committedFileHashes(root);
    await atomicJson(join(v5Root, "manifest.json"), manifest);
  };
  await persistManifest();

  const parentProvider = providerFor(input.compilerModel);
  const parent = unwrap(await client.session.create({ directory, title: "V5 finalization", agent: "evidence-compiler", model: { id: input.compilerModel, providerID: parentProvider, variant: "medium" } }, { signal: input.signal }), "finalization parent session creation");
  const promptSession = async (agent: "evidence-compiler" | "evidence-auditor", title: string, payload: Record<string, unknown>): Promise<{ response: AssistantMessage; sessionId: string }> => {
    const model = agent === "evidence-auditor" ? input.auditorModel : input.compilerModel;
    const providerID = providerFor(model);
    const session = unwrap(await client.session.create({ directory, parentID: parent.id, title, agent, model: { id: model, providerID, variant: "medium" } }, { signal: input.signal }), `${agent} session creation`);
    input.registerExcerptAllowance(session.id, 0);
    const response = unwrap(await client.session.prompt({ sessionID: session.id, directory, agent, model: { providerID, modelID: model }, variant: "medium", ...payload }, { signal: input.signal }), `${agent} prompt`);
    return { response: response as unknown as AssistantMessage, sessionId: session.id };
  };
  const extractWithCompletion = async <T>(
    agent: "evidence-compiler" | "evidence-auditor",
    sessionId: string,
    response: AssistantMessage,
    schema: z.ZodType<T>,
  ): Promise<{ value: unknown; response: AssistantMessage; completionContinuation: boolean }> => {
    try { return { value: extractMarkedJson(response), response, completionContinuation: false }; }
    catch (error) {
      if (structuredOutputRecovery(error) !== "SAME_SESSION_COMPLETION") throw error;
      const model = agent === "evidence-auditor" ? input.auditorModel : input.compilerModel;
      const providerID = providerFor(model);
      const continuation = unwrap(await client.session.prompt({
        sessionID: sessionId,
        directory,
        agent,
        model: { providerID, modelID: model },
        variant: "medium",
        tools: { "source.excerpts": false, skill: false },
        ...finalizerPromptPayload(
          input.finalizerProvider,
          model,
          "Your preceding turn completed the analysis but omitted the final answer. Do not repeat the analysis, revisit sources, or add prose. Using only the analysis already completed in this session, return the complete compact result now.",
          schema,
        ),
      }, { signal: input.signal }), `${agent} same-session completion`);
      const completedResponse = continuation as unknown as AssistantMessage;
      return { value: extractMarkedJson(completedResponse), response: completedResponse, completionContinuation: true };
    }
  };
  let compilerAttempts: 1 | 2 = 1;
  let auditorAttempts: 1 | 2 = 1;
  const promptValidated = async <T>(agent: "evidence-compiler" | "evidence-auditor", title: string, contract: string, payload: unknown, schema: z.ZodType<T>, validate: (value: unknown) => T = (value) => schema.parse(value)): Promise<T> => {
    const model = agent === "evidence-auditor" ? input.auditorModel : input.compilerModel;
    let originalResponse = "";
    let validatorError = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const requestPayload = attempt === 0 ? payload : finalizerRepairPayload(originalResponse, validatorError);
      const prompted = await promptSession(agent, `${title}${attempt ? " repair" : ""}`, { tools: { "source.excerpts": false, skill: false }, ...finalizerPromptPayload(input.finalizerProvider, model, promptWithPayload(contract, requestPayload), schema) });
      const attemptPath = join(v5Root, "attempts", `${Date.now()}-${randomUUID()}.json`);
      let completionContinuation = false;
      try {
        const completed = await extractWithCompletion(agent, prompted.sessionId, prompted.response, schema);
        completionContinuation = completed.completionContinuation;
        originalResponse = assistantText(completed.response);
        await atomicJson(attemptPath, { agent, title, attempt: attempt + 1, completionContinuation, originalResponse });
        const value = validate(completed.value);
        if (attempt) {
          if (agent === "evidence-auditor") auditorAttempts = 2;
          else compilerAttempts = 2;
        }
        return value;
      } catch (error) {
        if (!originalResponse) originalResponse = assistantText(prompted.response);
        validatorError = error instanceof Error ? error.message : String(error);
        await atomicJson(attemptPath, { agent, title, attempt: attempt + 1, completionContinuation, originalResponse, validatorError });
        if (attempt === 1) throw error;
      }
    }
    throw new Error(`${title} produced no validated result.`);
  };

  const claims: ValidatedClaim[] = await readStageRecords(root, "claims", (value) => validatedClaimSchema.parse(value));
  const storedCoverage = await readJsonIfPresent(join(v5Root, "coverage.json"), (value) => value as { exclusions?: ValidatedExclusion[] });
  const exclusions: ValidatedExclusion[] = storedCoverage?.exclusions ? [...storedCoverage.exclusions] : [];
  const dispositions = new Set<string>([...claims.flatMap(({ lineIds }) => lineIds), ...exclusions.flatMap(({ lineIds }) => lineIds)]);
  const semanticLines = catalog.lines.filter(({ layout }) => layout === "SEMANTIC");
  while (semanticLines.some(({ id }) => !dispositions.has(id))) {
    input.signal.throwIfAborted();
    const before = dispositions.size;
    const unresolved = new Set(semanticLines.filter(({ id }) => !dispositions.has(id)).map(({ id }) => id));
    const window = lineWindow(catalog, unresolved);
    if (!window.assignedLines.length) throw new Error("Claim scheduler cannot make progress.");
    let assignedLineIds = window.assignedLines.map(({ id }) => id);
    let originalResponse = "";
    let validatorError = "";
    for (let attempt = 0; attempt < 2 && assignedLineIds.length; attempt += 1) {
      const claimWindow = {
        contextLines: window.contextLines,
        lineWindow: catalog.lines.filter(({ id }) => assignedLineIds.includes(id)),
        acceptedClaims: claims.slice(-20).map((claim) => ({ claimKey: claim.claimKey, statement: claim.statement, facets: claim.facets.map(({ key, label }) => ({ key, statement: label })) })),
      };
      const requestPayload = attempt
        ? { ...claimWindow, repair: finalizerRepairPayload(originalResponse, validatorError) }
        : claimWindow;
      const prompted = await promptSession("evidence-compiler", `Claim batch ${claims.length + 1}${attempt ? " repair" : ""}`, {
        tools: { "source.excerpts": false, skill: false },
        ...finalizerPromptPayload(input.finalizerProvider, input.compilerModel, promptWithPayload(CLAIM_BATCH_PROMPT_CONTRACT, requestPayload), claimBatchSchema),
      });
      const attemptPath = join(v5Root, "attempts", `${Date.now()}-${randomUUID()}.json`);
      let completionContinuation = false;
      let validated;
      try {
        const completed = await extractWithCompletion("evidence-compiler", prompted.sessionId, prompted.response, claimBatchSchema);
        completionContinuation = completed.completionContinuation;
        originalResponse = assistantText(completed.response);
        await atomicJson(attemptPath, { agent: "evidence-compiler", title: `Claim batch ${claims.length + 1}`, attempt: attempt + 1, completionContinuation, originalResponse });
        validated = validateClaimBatchRecords(completed.value, catalog, assignedLineIds, "C", claims.length);
      }
      catch (error) {
        if (!originalResponse) originalResponse = assistantText(prompted.response);
        validatorError = error instanceof Error ? error.message : String(error);
        await atomicJson(attemptPath, { agent: "evidence-compiler", title: `Claim batch ${claims.length + 1}`, attempt: attempt + 1, completionContinuation, originalResponse, validatorError });
        if (attempt === 1) throw error;
        continue;
      }
      claims.push(...validated.claims);
      exclusions.push(...validated.exclusions);
      for (const claim of validated.claims) {
        for (const lineId of claim.lineIds) dispositions.add(lineId);
        await atomicJson(join(v5Root, "claims", `${claim.claimKey}.json`), claim);
      }
      for (const exclusion of validated.exclusions) for (const lineId of exclusion.lineIds) dispositions.add(lineId);
      await atomicJson(join(v5Root, "coverage.json"), { semanticLineIds: semanticLines.map(({ id }) => id), exclusions, claimedLineIds: [...dispositions] });
      await persistManifest();
      if (validated.defects.length && !validated.unresolvedLineIds.length) throw new Error(`Claim batch returned unscoped malformed records: ${validated.defects.join("; ")}`);
      assignedLineIds = validated.unresolvedLineIds;
      validatorError = [validated.defects.join("\n"), assignedLineIds.length ? `Unresolved line IDs: ${assignedLineIds.join(", ")}. Valid siblings were committed and must not be repeated.` : ""].filter(Boolean).join("\n");
      if (attempt && assignedLineIds.length) throw new Error(`Claim batch remained invalid after one local repair: ${validatorError}`);
      if (attempt) compilerAttempts = 2;
    }
    if (dispositions.size === before) throw new Error("Claim scheduler made no progress on the earliest unresolved line.");
  }

  const evidenceConfiguration = {
    claimsHash: digest(claims),
    sourceHashes: Object.fromEntries(sources.map(({ ref, sha256 }) => [ref, sha256])),
    sourceAuthorityPolicyVersion: sourceAuthority.policyVersion,
    sourceAuthoritySnapshotHash: digest(sourceAuthority),
    officialDomainRegistryHash: sourceAuthority.registryHash,
    retrievalVersion: "memo-first-bounded-v4-deduplicated",
    schemaHash: digest(z.toJSONSchema(evidenceJudgmentSchema)),
    promptHash: digest(EVIDENCE_JUDGE_PROMPT_CONTRACT),
    compilerModel: input.compilerModel,
  };
  const evidenceFingerprint = digest(evidenceConfiguration);
  if (invalidatedFinalizationStages({ evidence: manifest.stages.evidence?.fingerprint }, { evidence: evidenceFingerprint }).includes("evidence")) {
    await rm(join(v5Root, "evidence"), { recursive: true, force: true });
    await rm(join(v5Root, "summary.json"), { force: true });
    await rm(join(v5Root, "audit.json"), { force: true });
    await mkdir(join(v5Root, "evidence"), { recursive: true, mode: 0o700 });
    delete manifest.stages.summary;
    delete manifest.stages.audit;
  }
  manifest.stages.evidence = { fingerprint: evidenceFingerprint, configuration: evidenceConfiguration };
  const candidateSets = new Map<string, StoredExcerptCandidates>();
  const judgments = new Map<string, EvidenceJudgment>();
  const judgeClaim = async (claim: ValidatedClaim, repairDefects?: Audit["defects"]): Promise<void> => {
    const candidatePath = join(v5Root, "evidence", `${claim.claimKey}.candidates.json`);
    const judgmentPath = join(v5Root, "evidence", `${claim.claimKey}.judgment.json`);
    let candidateSet = await readJsonIfPresent(candidatePath, (value) => candidateSetSchema.parse(value));
    if (!candidateSet) {
      candidateSet = await input.sourceStore.findStoredExcerpts({
        statement: claim.statement,
        facets: claim.facets.map(({ key, label }) => ({ key, statement: label })),
        researchMemos: input.researchMemos,
        eligibleSourceRefs,
      });
      await atomicJson(candidatePath, candidateSet);
    }
    candidateSets.set(claim.claimKey, candidateSet);
    const byFacet = new Map(Object.entries(candidateSet.candidatesByFacet));
    let judgment = !repairDefects ? await readJsonIfPresent(judgmentPath, (value) => evidenceJudgmentSchema.parse(value)) : undefined;
    if (judgment) judgment = validateEvidenceJudgment(judgment, claim, byFacet, candidateSet.fingerprint);
    if (!judgment) {
      const candidateCount = Object.values(candidateSet.candidatesByFacet).reduce((sum, values) => sum + values.length, 0);
      judgment = candidateCount === 0
        ? evidenceJudgmentSchema.parse({ claimId: claim.claimKey, candidateSetHash: candidateSet.fingerprint, facets: claim.facets.map(({ key }) => ({ facetKey: key, candidates: [] })) })
        : await promptValidated("evidence-compiler", `Evidence ${claim.claimKey}`, EVIDENCE_JUDGE_PROMPT_CONTRACT, {
          claim: { claimId: claim.claimKey, statement: claim.statement, facets: claim.facets.map(({ key, label }) => ({ key, statement: label })) },
          candidateSetHash: candidateSet.fingerprint,
          candidatesByFacet: candidateSet.candidatesByFacet,
          ...(repairDefects ? { auditDefects: repairDefects, previousJudgment: judgments.get(claim.claimKey) } : {}),
        }, evidenceJudgmentSchema, (value) => validateEvidenceJudgment(value, claim, byFacet, candidateSet.fingerprint));
      await atomicJson(judgmentPath, judgment);
    }
    judgments.set(claim.claimKey, judgment);
    await persistManifest();
  };
  for (const claim of claims) await judgeClaim(claim);

  const materializeEvidence = async (): Promise<V5Evidence[]> => {
    const records: V5Evidence[] = [];
    for (const claim of claims) {
      const candidateSet = candidateSets.get(claim.claimKey)!;
      const candidateByRef = new Map(Object.values(candidateSet.candidatesByFacet).flat().map((candidate) => [candidate.ref, candidate]));
      const groups = new Map<string, { relation: "SUPPORTS" | "CONTRADICTS"; excerpt: ExcerptRecord; facetKeys: string[] }>();
      for (const facet of judgments.get(claim.claimKey)!.facets) {
        for (const candidate of facet.candidates) {
          if (candidate.relation === "IRRELEVANT") continue;
          const excerpt = candidateByRef.get(candidate.excerptRef);
          if (!excerpt || !eligibleSourceRefs.has(excerpt.sourceRef)) throw new Error(`Evidence judgment resolved an ineligible excerpt ${candidate.excerptRef}.`);
          const key = `${candidate.relation}:${candidate.excerptRef}`;
          const group = groups.get(key) ?? { relation: candidate.relation, excerpt, facetKeys: [] };
          group.facetKeys.push(facet.facetKey);
          groups.set(key, group);
        }
      }
      for (const group of groups.values()) {
        for (const facetKey of group.facetKeys) {
          const facet = claim.facets.find(({ key }) => key === facetKey);
          if (!facet || !facetEvidenceCompatible(group.excerpt.text, facet.label)) throw new Error(`Evidence excerpt ${group.excerpt.ref} is semantically incompatible with ${claim.claimKey}/${facetKey}.`);
        }
        const exact = await input.sourceStore.verifyExactQuote({ sourceRef: group.excerpt.sourceRef, path: group.excerpt.path, exactQuote: group.excerpt.text });
        if (!exact.valid) throw new Error(`Evidence excerpt ${group.excerpt.ref} is not an exact immutable quote.`);
        records.push({ key: `E${String(records.length + 1).padStart(3, "0")}`, claimKey: claim.claimKey, facetKeys: [...new Set(group.facetKeys)], relation: group.relation, sourceRef: group.excerpt.sourceRef, exactQuote: group.excerpt.text, sourceLocation: { path: group.excerpt.path } });
      }
    }
    return records;
  };
  let evidence = await materializeEvidence();
  let draftClaims = claims.map((claim) => claimDraft(claim, evidence.filter(({ claimKey }) => claimKey === claim.claimKey), judgments.get(claim.claimKey)));
  const compileSummary = async (repairDefects?: Audit["defects"]) => promptValidated("evidence-compiler", "V5 summary and timeline", SUMMARY_TIMELINE_PROMPT_CONTRACT, {
    claims: draftClaims.map((claim) => ({ claimKey: claim.key, statement: claim.statement, facets: claim.facets.map(({ key, label, materiality }) => ({ key, label, materiality })) })),
    evidence,
    ...(repairDefects ? { auditDefects: repairDefects } : {}),
  }, summaryTimelineOutputSchema);
  const summaryConfiguration = { claimsHash: digest(claims), evidenceHash: digest(evidence), schemaHash: digest(z.toJSONSchema(summaryTimelineOutputSchema)), promptHash: digest(SUMMARY_TIMELINE_PROMPT_CONTRACT), compilerModel: input.compilerModel };
  const summaryFingerprint = digest(summaryConfiguration);
  if (invalidatedFinalizationStages({ summary: manifest.stages.summary?.fingerprint }, { summary: summaryFingerprint }).includes("summary")) {
    await rm(join(v5Root, "summary.json"), { force: true });
    await rm(join(v5Root, "audit.json"), { force: true });
    delete manifest.stages.summary;
    delete manifest.stages.audit;
  }
  let summary = manifest.stages.summary?.fingerprint === summaryFingerprint ? await readJsonIfPresent(join(v5Root, "summary.json"), (value) => summaryTimelineOutputSchema.parse(value)) : undefined;
  if (!summary) {
    summary = await compileSummary();
    await atomicJson(join(v5Root, "summary.json"), summary);
  }
  manifest.stages.summary = { fingerprint: summaryFingerprint, configuration: summaryConfiguration };
  await persistManifest();

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
  let draft = investigationDraftSchema.parse({ ...summary, claims: draftClaims, evidence });
  const judgmentReasonsByClaim = () => new Map([...judgments].map(([claimKey, judgment]) => [claimKey, judgment.facets.flatMap((facet) => facet.candidates.map(({ reason }) => reason))]));
  const validateDraft = () => canonicalizeInvestigationResult(draft, { run: provisionalRun, sourceStore: input.sourceStore, authoritySnapshot: sourceAuthority, judgmentReasonsByClaim: judgmentReasonsByClaim(), compilerAttempts, auditorAttempts, warnings, providerCalls: input.budget.snapshot().externalNetworkCalls });
  await validateDraft();
  const auditOnce = async () => {
    const value = await promptValidated("evidence-auditor", "V5 independent audit", V5_AUDITOR_PROMPT_CONTRACT, { input: parsedInput, lineCatalog: catalog, exclusions, claims: draftClaims, evidence, candidateJudgments: [...judgments.values()], summary, officialDomainRegistry, sourceAuthoritySnapshot: sourceAuthority }, v5AuditSchema);
    await atomicJson(join(v5Root, "audit.json"), value);
    return value;
  };
  let auditConfiguration = { claimsHash: digest(claims), evidenceHash: digest(evidence), summaryHash: digest(summary), schemaHash: digest(z.toJSONSchema(v5AuditSchema)), promptHash: digest(V5_AUDITOR_PROMPT_CONTRACT), auditorModel: input.auditorModel };
  let auditFingerprint = digest(auditConfiguration);
  if (manifest.stages.audit?.fingerprint && manifest.stages.audit.fingerprint !== auditFingerprint) {
    await rm(join(v5Root, "audit.json"), { force: true });
    delete manifest.stages.audit;
  }
  let audit = manifest.stages.audit?.fingerprint === auditFingerprint ? await readJsonIfPresent(join(v5Root, "audit.json"), (value) => v5AuditSchema.parse(value)) : undefined;
  if (!audit) {
    audit = await auditOnce();
    manifest.stages.audit = { fingerprint: auditFingerprint, configuration: auditConfiguration };
    await persistManifest();
  }
  let material = audit.defects.filter(({ severity }) => severity === "MATERIAL");
  if (audit.status !== "PASSED" || material.length) {
    const affectedClaims = [...new Set(material.flatMap(({ claimKeys }) => claimKeys))];
    const repairable = material.length > 0 && affectedClaims.length <= 3 && material.every((defect) => defect.repairable && (defect.stage === "EVIDENCE" || defect.stage === "SUMMARY"));
    if (!repairable) throw new Error(`V5 audit failed: ${material.map(({ message }) => message).join("; ") || "unscoped audit defect"}`);
    for (const claimKey of affectedClaims) {
      const claim = claims.find((item) => item.claimKey === claimKey);
      if (!claim) throw new Error(`Audit repair references unknown claim ${claimKey}.`);
      await judgeClaim(claim, material.filter((defect) => defect.claimKeys.includes(claimKey)));
    }
    evidence = await materializeEvidence();
    draftClaims = claims.map((claim) => claimDraft(claim, evidence.filter(({ claimKey }) => claimKey === claim.claimKey), judgments.get(claim.claimKey)));
    summary = await compileSummary(material);
    await atomicJson(join(v5Root, "summary.json"), summary);
    draft = investigationDraftSchema.parse({ ...summary, claims: draftClaims, evidence });
    compilerAttempts = 2;
    auditorAttempts = 2;
    await validateDraft();
    audit = await auditOnce();
    material = audit.defects.filter(({ severity }) => severity === "MATERIAL");
    if (audit.status !== "PASSED" || material.length) throw new Error(`V5 audit failed after one bounded repair: ${material.map(({ message }) => message).join("; ") || "unscoped audit defect"}`);
  }
  const finalSummaryConfiguration = { ...summaryConfiguration, evidenceHash: digest(evidence) };
  manifest.stages.summary = { fingerprint: digest(finalSummaryConfiguration), configuration: finalSummaryConfiguration };
  auditConfiguration = { claimsHash: digest(claims), evidenceHash: digest(evidence), summaryHash: digest(summary), schemaHash: digest(z.toJSONSchema(v5AuditSchema)), promptHash: digest(V5_AUDITOR_PROMPT_CONTRACT), auditorModel: input.auditorModel };
  auditFingerprint = digest(auditConfiguration);
  manifest.stages.audit = { fingerprint: auditFingerprint, configuration: auditConfiguration };
  await input.budget.flush();
  const stats = await input.sourceStore.requestStats();
  const final = await canonicalizeInvestigationResult(draft, {
    run: { ...provisionalRun, finishedAt: new Date().toISOString(), budgets: { modelUsd: input.budget.snapshot().modelUsd, providerUsd: input.budget.snapshot().providerUsd, externalNetworkCalls: input.budget.snapshot().externalNetworkCalls } },
    sourceStore: input.sourceStore,
    authoritySnapshot: sourceAuthority,
    judgmentReasonsByClaim: judgmentReasonsByClaim(),
    compilerAttempts,
    auditorAttempts,
    warnings,
    providerCalls: stats.providerCalls,
    cacheHits: stats.cacheHits,
  });
  await persistManifest();
  input.onProgress?.(`V5 finalization audit passed with ${final.claims.length} claims and ${final.evidence.length} evidence items.`);
  return final;
}
