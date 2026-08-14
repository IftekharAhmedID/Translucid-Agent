import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { z } from "zod";

import { extractMarkedJson, structuredOutputRecovery } from "../agent/structured-output.ts";
import { finalizerModelDefinition } from "../core/model-catalog.ts";
import { FINALIZER_IMPLEMENTATION_VERSION, HANDOFF_MANIFEST_PATH, finalizerImplementationHash, writeResearchCheckpoint } from "./checkpoint.ts";
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
  buildClaimBundles,
  bundleEvidenceJudgmentSchema,
  claimBatchSchema,
  claimBundlePlanSchema,
  invalidatedFinalizationStages,
  mapWithConcurrency,
  v5StageManifestSchema,
  v5AuditSchema,
  readJsonIfPresent,
  validatedClaimSchema,
  validateClaimBatchRecords,
  validateBundleEvidenceJudgment,
  type BundleEvidenceJudgment,
  type ClaimBundlePlan,
  type ExcerptRecord,
  type ValidatedClaim,
  type ValidatedExclusion,
  type V5Audit,
  type V5StageManifest,
} from "./incremental-finalization.ts";
import { buildLineCatalog, lineCatalogSchema, type LineCatalog } from "./line-catalog.ts";
import { CLAIM_BATCH_PROMPT_CONTRACT, EVIDENCE_JUDGE_PROMPT_CONTRACT, promptWithPayload, V5_AUDITOR_PROMPT_CONTRACT } from "./prompt-contracts.ts";
import { buildDeterministicSummaryTimeline, canonicalizeInvestigationResult, investigationDraftSchema, type InvestigationDraft, type InvestigationResult } from "./result-contract.ts";
import { loadSourceAuthority, OFFICIAL_DOMAIN_REGISTRY_PATH } from "./source-authority.ts";

const directory = "/workspace/case";
const stageDirectory = ".work/finalization/v5";
const provenanceDirectory = "provenance/finalization";
const bundleExcerptSchema = z.object({
  ref: z.string().regex(/^X[a-f0-9]{64}$/),
  sourceRef: z.string().regex(/^S[1-9]\d*$/),
  path: z.string().min(1),
  offsetStart: z.number().int().nonnegative(),
  offsetEnd: z.number().int().positive(),
  text: z.string().min(1).max(1_000),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceUrl: z.string().optional(),
  title: z.string().optional(),
  provider: z.string().min(1),
  providerRoute: z.string().min(1),
  effectiveAuthority: z.string().min(1),
  evidenceEligible: z.boolean(),
}).strict();
const bundleCandidateSetSchema = z.object({
  bundleId: z.string().regex(/^B0*[1-9]\d*$/),
  facets: z.array(z.object({ claimKey: z.string().regex(/^C0*[1-9]\d*$/), facetKey: z.string().min(1), candidates: z.array(bundleExcerptSchema).max(6) }).strict()).max(60),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  totalCharacters: z.number().int().nonnegative().max(30_000),
  uniqueExcerpts: z.number().int().nonnegative().max(30),
}).strict();
const bundlePacketSchema = z.object({
  schemaVersion: z.literal(1),
  bundleId: z.string().regex(/^B0*[1-9]\d*$/),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  claims: z.array(validatedClaimSchema).min(1).max(5),
  candidateSet: bundleCandidateSetSchema,
}).strict();

type V5Input = FinalizationPipelineInput;
type V5Evidence = InvestigationDraft["evidence"][number];
type V5Claim = InvestigationDraft["claims"][number];
type Audit = V5Audit;

export async function publishFinalizationProvenance(root: string): Promise<void> {
  const target = join(root, provenanceDirectory);
  const temporary = join(root, "provenance", `.finalization.${randomUUID()}.tmp`);
  await mkdir(join(root, "provenance"), { recursive: true });
  try {
    await cp(join(root, stageDirectory), temporary, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
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
  for (const directoryName of ["claims", "bundles"]) {
    const directoryPath = join(root, stageDirectory, directoryName);
    const entries = await readdir(directoryPath, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
    for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".json")).sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = `${directoryName}/${entry.name}`;
      output[relativePath] = await fileDigest(join(directoryPath, entry.name));
    }
  }
  for (const name of ["line-catalog.json", "coverage.json", "official-domain-registry.json", "source-authority-snapshot.json", "implementation.json", "summary.json", "audit.json"]) {
    try { output[name] = await fileDigest(join(root, stageDirectory, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return output;
}

function unwrap<T>(result: { data?: T; error?: unknown }, action: string): T {
  if (result.error || result.data === undefined) throw new Error(`${action} failed: ${describeSdkError(result.error ?? "missing data")}`);
  return result.data;
}

class FinalizerTransportError extends Error {
  readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "FinalizerTransportError";
    this.cause = cause;
  }
}

class FinalizerOutputError extends Error {
  constructor(message: string, readonly responseText: string) {
    super(message);
    this.name = "FinalizerOutputError";
  }
}

function boundedDiagnostic(value: string, maximumCharacters = 100_000): string {
  return value.length <= maximumCharacters ? value : `${value.slice(0, maximumCharacters)}\n[truncated]`;
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

function claimDraft(claim: ValidatedClaim, evidence: V5Evidence[]): V5Claim {
  return {
    key: claim.claimKey,
    category: claim.category,
    statement: claim.statement,
    materiality: claim.materiality,
    sourceSpan: { ...claim.sourceSpan },
    explanation: `Evidence relations: ${evidence.filter(({ relation }) => relation === "SUPPORTS").length} supporting, ${evidence.filter(({ relation }) => relation === "CONTRADICTS").length} contradicting.`,
    facets: claim.facets.map((facet) => {
      const relations = evidence.filter(({ facetKeys }) => facetKeys.includes(facet.key)).map(({ relation }) => relation);
      const status = relations.includes("CONTRADICTS") ? "CONTRADICTED" : relations.includes("SUPPORTS") ? "SUPPORTED" : "UNRESOLVED";
      const note = status === "SUPPORTED" ? "Accepted evidence supports this facet." : status === "CONTRADICTED" ? "Accepted evidence contradicts this facet." : "No eligible accepted evidence resolves this facet.";
      return { key: facet.key, label: facet.label, materiality: facet.materiality, status, note };
    }),
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
  const preservedSourceIntegrity = await input.sourceStore.verify();
  if (!preservedSourceIntegrity.valid) throw new Error(`Preserved source integrity failed for ${preservedSourceIntegrity.invalidSourceRefs.join(", ")}.`);
  const { registry: officialDomainRegistry, snapshot: sourceAuthority } = await loadSourceAuthority(root, input.sourceStore);
  const v5Root = join(root, stageDirectory);
  const parsedInput = base.input as Parameters<typeof buildLineCatalog>[0];
  const builtCatalog = buildLineCatalog(parsedInput);
  const handoffResearch = await readJsonIfPresent(join(root, HANDOFF_MANIFEST_PATH), (value) => value as { research?: { fingerprint?: string } });
  const finalizerImplementationSha256 = await finalizerImplementationHash(input.repositoryRoot);
  const claimsConfiguration = {
    implementation: FINALIZER_IMPLEMENTATION_VERSION,
    finalizerImplementationSha256,
    researchFingerprint: handoffResearch?.research?.fingerprint ?? input.inputSha256,
    inputSha256: input.inputSha256,
    lineCatalogFingerprint: builtCatalog.fingerprint,
    schemaHash: digest(z.toJSONSchema(claimBatchSchema)),
    promptHash: digest(CLAIM_BATCH_PROMPT_CONTRACT),
    compilerModel: input.compilerModel,
    runtimeManifestHash: input.handle.manifestHash,
  };
  const claimsFingerprint = digest(claimsConfiguration);
  const rawManifest = await readJsonIfPresent(join(v5Root, "manifest.json"), (value) => value);
  let storedManifest: V5StageManifest | undefined;
  if (rawManifest) {
    const parsed = v5StageManifestSchema.safeParse(rawManifest);
    if (parsed.success) storedManifest = parsed.data;
    else if ((rawManifest as { schemaVersion?: unknown; implementation?: unknown }).schemaVersion === 3 && (rawManifest as { implementation?: unknown }).implementation === "incremental-finalizer-v5") {
      await rm(v5Root, { recursive: true, force: true });
    } else {
      throw new Error(`Invalid V5.1 stage manifest: ${z.prettifyError(parsed.error)}`);
    }
  }
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
      await rm(join(v5Root, "bundles"), { recursive: true, force: true });
      await rm(join(v5Root, "summary.json"), { force: true });
      await rm(join(v5Root, "audit.json"), { force: true });
      delete storedManifest.stages.evidence;
      delete storedManifest.stages.summary;
      delete storedManifest.stages.audit;
    } else {
      if (invalidFiles.includes("coverage.json")) await rm(join(v5Root, "coverage.json"), { force: true });
      if (invalidFiles.includes("source-authority-snapshot.json")) await rm(join(v5Root, "source-authority-snapshot.json"), { force: true });
      for (const path of invalidFiles.filter((value) => value.startsWith("bundles/"))) {
        await rm(join(v5Root, path), { force: true });
        if (path.endsWith(".packet.json")) await rm(join(v5Root, path.replace(".packet.json", ".judgment.json")), { force: true });
      }
      if (invalidFiles.some((path) => path.startsWith("bundles/") || path === "summary.json" || path === "implementation.json")) {
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
  await mkdir(join(v5Root, "bundles"), { recursive: true, mode: 0o700 });
  const attemptsRoot = join(root, ".work", "finalization", "attempts", "v5.1");
  await mkdir(attemptsRoot, { recursive: true, mode: 0o700 });
  const storedCatalog = await readJsonIfPresent(join(v5Root, "line-catalog.json"), (value) => lineCatalogSchema.parse(value));
  if (storedCatalog && storedCatalog.fingerprint !== builtCatalog.fingerprint) throw new Error("Finalization line catalog changed since the V5 checkpoint was created.");
  const catalog = storedCatalog ?? builtCatalog;
  if (!storedCatalog) await atomicJson(join(v5Root, "line-catalog.json"), catalog);
  await atomicJson(join(root, OFFICIAL_DOMAIN_REGISTRY_PATH), officialDomainRegistry);
  await atomicJson(join(v5Root, "official-domain-registry.json"), officialDomainRegistry);
  await atomicJson(join(v5Root, "source-authority-snapshot.json"), sourceAuthority);
  await atomicJson(join(v5Root, "implementation.json"), {
    implementation: FINALIZER_IMPLEMENTATION_VERSION,
    finalizerImplementationSha256,
    producingGitCommit: input.dossierCheckpointConfig.producingGitCommit,
    inputSha256: input.inputSha256,
    inputManifestSha256: await fileDigest(join(root, "input", "manifest.json")),
    sourceManifestSha256: await fileDigest(join(root, "sources", "manifest.json")),
    sourceHashes: Object.fromEntries(sources.map(({ ref, sha256 }) => [ref, sha256])),
    researchMemosSha256: digest(input.researchMemos),
    handoffManifestSha256: await fileDigest(join(root, HANDOFF_MANIFEST_PATH)),
    officialDomainRegistryHash: officialDomainRegistry.registryHash,
    runtimeManifestHash: input.handle.manifestHash,
    promptHashes: { claims: digest(CLAIM_BATCH_PROMPT_CONTRACT), evidence: digest(EVIDENCE_JUDGE_PROMPT_CONTRACT), audit: digest(V5_AUDITOR_PROMPT_CONTRACT) },
    schemaHashes: { claims: digest(z.toJSONSchema(claimBatchSchema)), evidence: digest(z.toJSONSchema(bundleEvidenceJudgmentSchema)), audit: digest(z.toJSONSchema(v5AuditSchema)) },
    models: { research: input.researchModel, compiler: input.compilerModel, auditor: input.auditorModel },
  });
  const manifest: V5StageManifest = storedManifest ?? { schemaVersion: 4, implementation: "incremental-finalizer-v5.1", stages: {}, files: {} };
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
    try {
      const session = unwrap(await client.session.create({ directory, parentID: parent.id, title, agent, model: { id: model, providerID, variant: "medium" } }, { signal: input.signal }), `${agent} session creation`);
      input.registerExcerptAllowance(session.id, 0);
      const response = unwrap(await client.session.prompt({ sessionID: session.id, directory, agent, model: { providerID, modelID: model }, variant: "medium", ...payload }, { signal: input.signal }), `${agent} prompt`);
      return { response: response as unknown as AssistantMessage, sessionId: session.id };
    } catch (error) {
      throw new FinalizerTransportError(`${agent} request failed: ${error instanceof Error ? error.message : String(error)}`, error);
    }
  };
  const beginAttempt = async (agent: "evidence-compiler" | "evidence-auditor", title: string, attempt: number, payload: unknown) => {
    const attemptPath = join(attemptsRoot, `${Date.now()}-${randomUUID()}.json`);
    const base = {
      status: "STARTED" as const,
      startedAt: new Date().toISOString(),
      agent,
      model: agent === "evidence-auditor" ? input.auditorModel : input.compilerModel,
      title,
      attempt,
      payloadHash: digest(payload),
    };
    await atomicJson(attemptPath, base);
    return { attemptPath, base };
  };
  const finishAttempt = async (attempt: Awaited<ReturnType<typeof beginAttempt>>, status: "VALID" | "INVALID" | "TRANSPORT_ERROR", detail: Record<string, unknown> = {}) => {
    await atomicJson(attempt.attemptPath, { ...attempt.base, status, finishedAt: new Date().toISOString(), ...detail });
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
      let continuation;
      try {
        continuation = unwrap(await client.session.prompt({
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
      } catch (continuationError) {
        throw new FinalizerTransportError(`${agent} same-session completion failed: ${continuationError instanceof Error ? continuationError.message : String(continuationError)}`, continuationError);
      }
      const completedResponse = continuation as unknown as AssistantMessage;
      try { return { value: extractMarkedJson(completedResponse), response: completedResponse, completionContinuation: true }; }
      catch (continuationParseError) {
        throw new FinalizerOutputError(continuationParseError instanceof Error ? continuationParseError.message : String(continuationParseError), assistantText(completedResponse));
      }
    }
  };
  let compilerAttempts: 1 | 2 = 1;
  let auditorAttempts: 1 | 2 = 1;
  const promptValidated = async <T>(agent: "evidence-compiler" | "evidence-auditor", title: string, contract: string, payload: unknown, schema: z.ZodType<T>, validate: (value: unknown) => T = (value) => schema.parse(value), maximumAttempts = 2): Promise<T> => {
    const model = agent === "evidence-auditor" ? input.auditorModel : input.compilerModel;
    let originalResponse = "";
    let validatorError = "";
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      const requestPayload = attempt === 0 ? payload : { frozenInput: payload, repair: finalizerRepairPayload(originalResponse, validatorError) };
      const diagnostic = await beginAttempt(agent, title, attempt + 1, requestPayload);
      let prompted;
      try {
        prompted = await promptSession(agent, `${title}${attempt ? " repair" : ""}`, { tools: { "source.excerpts": false, skill: false }, ...finalizerPromptPayload(input.finalizerProvider, model, promptWithPayload(contract, requestPayload), schema) });
      } catch (error) {
        await finishAttempt(diagnostic, "TRANSPORT_ERROR", { transportError: boundedDiagnostic(error instanceof Error ? error.message : String(error), 8_000) });
        throw error;
      }
      let completionContinuation = false;
      try {
        const completed = await extractWithCompletion(agent, prompted.sessionId, prompted.response, schema);
        completionContinuation = completed.completionContinuation;
        originalResponse = assistantText(completed.response);
        const value = validate(completed.value);
        await finishAttempt(diagnostic, "VALID", { completionContinuation, originalResponse: boundedDiagnostic(originalResponse) });
        if (attempt) {
          if (agent === "evidence-auditor") auditorAttempts = 2;
          else compilerAttempts = 2;
        }
        return value;
      } catch (error) {
        if (!originalResponse) originalResponse = error instanceof FinalizerOutputError ? error.responseText : assistantText(prompted.response);
        validatorError = error instanceof Error ? error.message : String(error);
        const status = error instanceof FinalizerTransportError ? "TRANSPORT_ERROR" : "INVALID";
        await finishAttempt(diagnostic, status, { completionContinuation, originalResponse: boundedDiagnostic(originalResponse), ...(status === "TRANSPORT_ERROR" ? { transportError: boundedDiagnostic(validatorError, 8_000) } : { validatorError: boundedDiagnostic(validatorError, 8_000) }) });
        if (status === "TRANSPORT_ERROR") throw error;
        if (attempt === maximumAttempts - 1) throw error;
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
      const title = `Claim batch ${claims.length + 1}`;
      const diagnostic = await beginAttempt("evidence-compiler", title, attempt + 1, requestPayload);
      let prompted;
      try {
        prompted = await promptSession("evidence-compiler", `${title}${attempt ? " repair" : ""}`, {
          tools: { "source.excerpts": false, skill: false },
          ...finalizerPromptPayload(input.finalizerProvider, input.compilerModel, promptWithPayload(CLAIM_BATCH_PROMPT_CONTRACT, requestPayload), claimBatchSchema),
        });
      } catch (error) {
        await finishAttempt(diagnostic, "TRANSPORT_ERROR", { transportError: boundedDiagnostic(error instanceof Error ? error.message : String(error), 8_000) });
        throw error;
      }
      let completionContinuation = false;
      let validated;
      try {
        const completed = await extractWithCompletion("evidence-compiler", prompted.sessionId, prompted.response, claimBatchSchema);
        completionContinuation = completed.completionContinuation;
        originalResponse = assistantText(completed.response);
        validated = validateClaimBatchRecords(completed.value, catalog, assignedLineIds, "C", claims.length);
        const status = validated.defects.length || validated.unresolvedLineIds.length ? "INVALID" : "VALID";
        await finishAttempt(diagnostic, status, { completionContinuation, originalResponse: boundedDiagnostic(originalResponse), defects: validated.defects, unresolvedLineIds: validated.unresolvedLineIds });
      }
      catch (error) {
        if (!originalResponse) originalResponse = error instanceof FinalizerOutputError ? error.responseText : assistantText(prompted.response);
        validatorError = error instanceof Error ? error.message : String(error);
        const status = error instanceof FinalizerTransportError ? "TRANSPORT_ERROR" : "INVALID";
        await finishAttempt(diagnostic, status, { completionContinuation, originalResponse: boundedDiagnostic(originalResponse), ...(status === "TRANSPORT_ERROR" ? { transportError: boundedDiagnostic(validatorError, 8_000) } : { validatorError: boundedDiagnostic(validatorError, 8_000) }) });
        if (status === "TRANSPORT_ERROR") throw error;
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

  const plannedBundles = buildClaimBundles(claims, exclusions, catalog, input.inputSha256);
  const storedBundlePlan = await readJsonIfPresent(join(v5Root, "bundles", "plan.json"), (value) => claimBundlePlanSchema.parse(value));
  if (storedBundlePlan && digest(storedBundlePlan) !== digest(plannedBundles)) throw new Error("Frozen V5.1 bundle plan no longer matches the claim inventory.");
  const bundlePlan: ClaimBundlePlan = storedBundlePlan ?? plannedBundles;
  const evidenceConfiguration = {
    claimsHash: digest(claims),
    bundlePlanHash: digest(bundlePlan),
    sourceHashes: Object.fromEntries(sources.map(({ ref, sha256 }) => [ref, sha256])),
    researchMemosHash: digest(input.researchMemos),
    sourceAuthorityPolicyVersion: sourceAuthority.policyVersion,
    sourceAuthoritySnapshotHash: digest(sourceAuthority),
    officialDomainRegistryHash: sourceAuthority.registryHash,
    retrievalVersion: "whole-corpus-bundle-v1",
    limits: { candidatesPerFacet: 6, excerptsPerSourcePerFacet: 2, uniqueExcerptsPerBundle: 30, excerptCharactersPerBundle: 30_000, facetAssignmentsPerExcerpt: 3 },
    schemaHash: digest(z.toJSONSchema(bundleEvidenceJudgmentSchema)),
    promptHash: digest(EVIDENCE_JUDGE_PROMPT_CONTRACT),
    compilerModel: input.compilerModel,
  };
  const evidenceFingerprint = digest(evidenceConfiguration);
  if (invalidatedFinalizationStages({ evidence: manifest.stages.evidence?.fingerprint }, { evidence: evidenceFingerprint }).includes("evidence")) {
    await rm(join(v5Root, "bundles"), { recursive: true, force: true });
    await rm(join(v5Root, "summary.json"), { force: true });
    await rm(join(v5Root, "audit.json"), { force: true });
    await mkdir(join(v5Root, "bundles"), { recursive: true, mode: 0o700 });
    delete manifest.stages.summary;
    delete manifest.stages.audit;
  }
  await atomicJson(join(v5Root, "bundles", "plan.json"), bundlePlan);
  manifest.stages.evidence = { fingerprint: evidenceFingerprint, configuration: evidenceConfiguration };
  const claimByKey = new Map(claims.map((claim) => [claim.claimKey, claim]));
  const authorityBySourceRef = new Map(sourceAuthority.sources.map(({ sourceRef, sourceHash, effectiveAuthority }) => [sourceRef, { sourceHash, effectiveAuthority }]));
  const identityAnchors = claims.flatMap(({ facets }) => facets.filter(({ kind }) => kind === "IDENTITY").map(({ sourceFragment }) => sourceFragment));
  type BundlePacket = z.infer<typeof bundlePacketSchema>;
  const packets = new Map<string, BundlePacket>();
  const judgments = new Map<string, BundleEvidenceJudgment>();
  const packetFor = async (bundle: ClaimBundlePlan["bundles"][number]): Promise<BundlePacket> => {
    const path = join(v5Root, "bundles", `${bundle.bundleId}.packet.json`);
    const expectedClaims = bundle.claimKeys.map((claimKey) => {
      const claim = claimByKey.get(claimKey);
      if (!claim) throw new Error(`Bundle ${bundle.bundleId} references unknown claim ${claimKey}.`);
      return claim;
    });
    let packet = await readJsonIfPresent(path, (value) => bundlePacketSchema.parse(value));
    if (!packet) {
      const candidateSet = await input.sourceStore.findBundleExcerpts({
        bundleId: bundle.bundleId,
        claims: expectedClaims.map((claim) => ({ claimKey: claim.claimKey, statement: claim.statement, facets: claim.facets.map(({ key, kind, label, sourceFragment }) => ({ key, kind, statement: label, sourceFragment })) })),
        researchMemos: input.researchMemos,
        authorityBySourceRef,
      });
      const fingerprint = digest({ bundle, claims: expectedClaims, candidateSet, evidenceConfiguration });
      packet = bundlePacketSchema.parse({ schemaVersion: 1, bundleId: bundle.bundleId, fingerprint, claims: expectedClaims, candidateSet });
      await atomicJson(path, packet);
    }
    const expectedFingerprint = digest({ bundle, claims: expectedClaims, candidateSet: packet.candidateSet, evidenceConfiguration });
    if (packet.fingerprint !== expectedFingerprint || digest(packet.claims) !== digest(expectedClaims)) throw new Error(`Bundle packet ${bundle.bundleId} no longer matches its frozen inputs.`);
    packets.set(bundle.bundleId, packet);
    return packet;
  };
  const judgeBundle = async (bundle: ClaimBundlePlan["bundles"][number], repairDefects?: Audit["defects"]): Promise<void> => {
    const packet = await packetFor(bundle);
    const path = join(v5Root, "bundles", `${bundle.bundleId}.judgment.json`);
    let judgment = !repairDefects ? await readJsonIfPresent(path, (value) => bundleEvidenceJudgmentSchema.parse(value)) : undefined;
    if (judgment) judgment = validateBundleEvidenceJudgment(judgment, bundle.bundleId, packet.claims, packet.candidateSet, packet.fingerprint, identityAnchors);
    if (!judgment) {
      const candidateCount = packet.candidateSet.facets.reduce((sum, facet) => sum + facet.candidates.length, 0);
      judgment = candidateCount === 0
        ? bundleEvidenceJudgmentSchema.parse({ bundleId: bundle.bundleId, candidateSetHash: packet.fingerprint, dispositions: [] })
        : await promptValidated("evidence-compiler", `Evidence bundle ${bundle.bundleId}`, EVIDENCE_JUDGE_PROMPT_CONTRACT, {
          bundleId: bundle.bundleId,
          candidateSetHash: packet.fingerprint,
          claims: packet.claims.map((claim) => ({ claimKey: claim.claimKey, statement: claim.statement, facets: claim.facets.map(({ key, kind, label }) => ({ key, kind, statement: label })) })),
          candidates: packet.candidateSet.facets,
          ...(repairDefects ? { auditDefects: repairDefects, previousJudgment: judgments.get(bundle.bundleId) } : {}),
        }, bundleEvidenceJudgmentSchema, (value) => validateBundleEvidenceJudgment(value, bundle.bundleId, packet.claims, packet.candidateSet, packet.fingerprint, identityAnchors), repairDefects ? 1 : 2);
      await atomicJson(path, judgment);
    }
    judgments.set(bundle.bundleId, judgment);
  };
  const runBundleWorkers = async (bundles: ClaimBundlePlan["bundles"], defects?: Audit["defects"]): Promise<void> => {
    await mapWithConcurrency(bundles, 2, async (bundle) => judgeBundle(bundle, defects?.filter((defect) => defect.bundleId === bundle.bundleId)));
  };
  await runBundleWorkers(bundlePlan.bundles);
  await persistManifest();

  const materializeEvidence = async (): Promise<V5Evidence[]> => {
    const records: V5Evidence[] = [];
    for (const bundle of bundlePlan.bundles) {
      const packet = packets.get(bundle.bundleId)!;
      const candidateByAssignment = new Map(packet.candidateSet.facets.flatMap((facet) => facet.candidates.map((candidate) => [`${facet.claimKey}\0${facet.facetKey}\0${candidate.ref}`, candidate])));
      const groups = new Map<string, { claimKey: string; relation: "SUPPORTS" | "CONTRADICTS"; excerpt: ExcerptRecord; facetKeys: string[] }>();
      for (const disposition of judgments.get(bundle.bundleId)!.dispositions) {
        if (disposition.relation === "CONTEXT" || disposition.relation === "IRRELEVANT") continue;
        const excerpt = candidateByAssignment.get(`${disposition.claimKey}\0${disposition.facetKey}\0${disposition.excerptRef}`);
        if (!excerpt || !excerpt.evidenceEligible) throw new Error(`Evidence judgment resolved an ineligible excerpt ${disposition.excerptRef}.`);
        const groupKey = `${disposition.claimKey}\0${disposition.relation}\0${disposition.excerptRef}`;
        const group = groups.get(groupKey) ?? { claimKey: disposition.claimKey, relation: disposition.relation, excerpt, facetKeys: [] };
        group.facetKeys.push(disposition.facetKey);
        groups.set(groupKey, group);
      }
      for (const group of groups.values()) {
        const exact = await input.sourceStore.verifyExactQuote({ sourceRef: group.excerpt.sourceRef, path: group.excerpt.path, exactQuote: group.excerpt.text });
        if (!exact.valid) throw new Error(`Evidence excerpt ${group.excerpt.ref} is not an exact immutable quote.`);
        records.push({ key: `E${String(records.length + 1).padStart(3, "0")}`, claimKey: group.claimKey, facetKeys: [...new Set(group.facetKeys)], relation: group.relation, sourceRef: group.excerpt.sourceRef, exactQuote: group.excerpt.text, sourceLocation: { path: group.excerpt.path } });
      }
    }
    return records;
  };
  const assemble = async (auditWarnings: readonly string[] = []) => {
    const evidence = await materializeEvidence();
    const draftClaims = claims.map((claim) => claimDraft(claim, evidence.filter(({ claimKey }) => claimKey === claim.claimKey)));
    const contextDispositionCount = [...judgments.values()].flatMap(({ dispositions }) => dispositions).filter(({ relation }) => relation === "CONTEXT").length;
    const rejectedCandidateCount = [...judgments.values()].flatMap(({ dispositions }) => dispositions).filter(({ relation }) => relation === "IRRELEVANT").length;
    const summary = buildDeterministicSummaryTimeline(claims, evidence, { contextDispositionCount, rejectedCandidateCount, warnings: [...warnings, ...auditWarnings], authorityBySourceRef: new Map(sourceAuthority.sources.map(({ sourceRef, effectiveAuthority }) => [sourceRef, effectiveAuthority])) });
    const draft = investigationDraftSchema.parse({ ...summary, claims: draftClaims, evidence });
    return { evidence, draftClaims, summary, draft, contextDispositionCount, rejectedCandidateCount };
  };
  let assembled = await assemble();
  let { evidence, draftClaims, summary, draft } = assembled;
  const summaryConfiguration = { claimsHash: digest(claims), evidenceHash: digest(evidence), summaryVersion: "deterministic-v1" };
  const summaryFingerprint = digest(summaryConfiguration);
  if (manifest.stages.summary?.fingerprint && manifest.stages.summary.fingerprint !== summaryFingerprint) {
    await rm(join(v5Root, "audit.json"), { force: true });
    delete manifest.stages.audit;
  }
  await atomicJson(join(v5Root, "summary.json"), summary);
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
  let publishedWarnings = [...warnings];
  const validateDraft = () => canonicalizeInvestigationResult(draft, { run: provisionalRun, sourceStore: input.sourceStore, authoritySnapshot: sourceAuthority, compilerAttempts, auditorAttempts, warnings: publishedWarnings, rejectedCitations: assembled.rejectedCandidateCount, providerCalls: input.budget.snapshot().externalNetworkCalls });
  await validateDraft();
  const auditOnce = async () => {
    const value = await promptValidated("evidence-auditor", "V5.1 independent audit", V5_AUDITOR_PROMPT_CONTRACT, { input: parsedInput, lineCatalog: catalog, exclusions, bundlePlan, packets: bundlePlan.bundles.map(({ bundleId }) => packets.get(bundleId)!), claims: draftClaims, evidence, candidateJudgments: bundlePlan.bundles.map(({ bundleId }) => judgments.get(bundleId)!), summary, officialDomainRegistry, sourceAuthoritySnapshot: sourceAuthority }, v5AuditSchema);
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
    const affectedBundles = [...new Set(material.flatMap(({ bundleId }) => bundleId ? [bundleId] : []))];
    const repairable = material.length > 0 && affectedBundles.length === 1 && material.every((defect) => defect.repairable && defect.stage === "EVIDENCE" && defect.bundleId === affectedBundles[0]);
    if (!repairable) throw new Error(`V5 audit failed: ${material.map(({ message }) => message).join("; ") || "unscoped audit defect"}`);
    const bundle = bundlePlan.bundles.find(({ bundleId }) => bundleId === affectedBundles[0]);
    if (!bundle) throw new Error(`Audit repair references unknown bundle ${affectedBundles[0]}.`);
    await runBundleWorkers([bundle], material);
    assembled = await assemble();
    ({ evidence, draftClaims, summary, draft } = assembled);
    await atomicJson(join(v5Root, "summary.json"), summary);
    compilerAttempts = 2;
    auditorAttempts = 2;
    await validateDraft();
    audit = await auditOnce();
    material = audit.defects.filter(({ severity }) => severity === "MATERIAL");
    if (audit.status !== "PASSED" || material.length) throw new Error(`V5 audit failed after one bounded repair: ${material.map(({ message }) => message).join("; ") || "unscoped audit defect"}`);
  }
  const acceptedAuditWarnings = audit.defects.filter(({ severity }) => severity === "WARNING").map(({ message }) => message);
  if (acceptedAuditWarnings.length) {
    publishedWarnings = [...warnings, ...acceptedAuditWarnings];
    assembled = await assemble(acceptedAuditWarnings);
    ({ evidence, draftClaims, summary, draft } = assembled);
    await atomicJson(join(v5Root, "summary.json"), summary);
    await validateDraft();
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
    compilerAttempts,
    auditorAttempts,
    warnings: publishedWarnings,
    rejectedCitations: assembled.rejectedCandidateCount,
    providerCalls: stats.providerCalls,
    cacheHits: stats.cacheHits,
  });
  await persistManifest();
  input.onProgress?.(`V5 finalization audit passed with ${final.claims.length} claims and ${final.evidence.length} evidence items.`);
  return final;
}
