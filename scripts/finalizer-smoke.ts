import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { z } from "zod";

import { extractMarkedJson } from "../src/agent/structured-output.ts";
import { FINALIZER_MODEL_CATALOG, finalizerModelDefinition } from "../src/core/model-catalog.ts";
import { MemoryRunBudget } from "../src/headless/budget.ts";
import { describeSdkError, finalizerPromptPayload, finalizerRepairPayload, type AssistantMessage } from "../src/headless/finalization-controller.ts";
import { createHeadlessGateway } from "../src/headless/gateway.ts";
import { bundleEvidenceJudgmentSchema, claimBatchSchema, v5AuditSchema, validateBundleEvidenceJudgment, validateClaimBatchRecords } from "../src/headless/incremental-finalization.ts";
import { buildLineCatalog } from "../src/headless/line-catalog.ts";
import { CLAIM_BATCH_PROMPT_CONTRACT, EVIDENCE_JUDGE_PROMPT_CONTRACT, promptWithPayload, V5_AUDITOR_PROMPT_CONTRACT } from "../src/headless/prompt-contracts.ts";
import { FileSourceStore } from "../src/headless/source-store.ts";
import { getPinnedLocalManifestHash, LocalDockerRuntime } from "../src/runtime/local-docker.ts";
import type { RunHandle } from "../src/runtime/types.ts";

type QualificationCase = {
  name: string;
  agent: "evidence-compiler" | "evidence-auditor";
  contract: string;
  payload: unknown;
  schema: z.ZodType;
  semantic: (value: unknown) => void;
};
type Metrics = { model: string; calls: number; valid: number; firstPass: number; repairs: number; transportErrors: number; semanticDefects: number; invalid: number; elapsedMs: number; estimatedCostUsd: number; qualified: boolean };

const argumentsList = process.argv.slice(2);
const modelsIndex = argumentsList.indexOf("--models");
const requested = modelsIndex >= 0 ? argumentsList[modelsIndex + 1] : process.env.FINALIZER_MODEL ?? "deepseek-v4-pro";
if (!requested) throw new Error("--models requires a value.");
const models = requested === "all" ? FINALIZER_MODEL_CATALOG.map(({ id }) => id) : requested.split(",").map((value) => value.trim()).filter(Boolean);
for (const model of models) finalizerModelDefinition(model);
if (!process.env.OPENCODE_API_KEY) throw new Error("OPENCODE_API_KEY is required for live finalizer qualification.");
const provider = process.env.FINALIZER_OPENCODE_PROVIDER === "ZEN" ? "ZEN" : "GO";
const directory = "/workspace/case";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assistantText(message: AssistantMessage): string {
  return message.parts.flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("").trim();
}

function claimCase(name: string, lines: string[]): QualificationCase {
  const catalog = buildLineCatalog({ pages: [{ page: 1, lines: lines.map((text, index) => ({ line: index + 1, text })) }] });
  const lineIds = catalog.lines.filter(({ layout }) => layout === "SEMANTIC").map(({ id }) => id);
  return {
    name,
    agent: "evidence-compiler",
    contract: CLAIM_BATCH_PROMPT_CONTRACT,
    payload: { contextLines: [], lineWindow: catalog.lines, acceptedClaims: [] },
    schema: claimBatchSchema,
    semantic: (value) => {
      const valid = validateClaimBatchRecords(value, catalog, lineIds);
      if (valid.defects.length || valid.unresolvedLineIds.length || !valid.claims.length || valid.deferredLineIds.length) throw new Error(`Claim compilation remained incomplete: ${[...valid.defects, ...valid.unresolvedLineIds].join("; ")}`);
    },
  };
}

function claimCases(): QualificationCase[] {
  return [
    claimCase("claim-employment-tuple", ["Principal Engineer, Systems Unit, Organization Alpha, Austin, Texas, 2021–2024"]),
    claimCase("claim-title-progression", ["Engineer 2020–2022 → Senior Engineer 2022–2024"]),
    claimCase("claim-coordinated-proper-nouns", ["Research and Development, Example & Sons"]),
    claimCase("claim-multilingual-punctuation", ["Ingénieure principale；Unité Plateforme；Organisation Exemple；2021–2024"]),
    claimCase("claim-negated-responsibility", ["Did not manage Project North"]),
    claimCase("claim-wrapped-and-shared", ["The person has 20+ years in software", "engineering and contributes to Project Atlas"]),
  ];
}

function evidenceCase(input: {
  name: string;
  kind: "IDENTITY" | "ORGANIZATION" | "ORG_UNIT" | "TITLE" | "INTERVAL" | "LOCATION" | "ACTIVITY" | "RESPONSIBILITY" | "CONTRIBUTION" | "OUTPUT" | "EDUCATION" | "AFFILIATION" | "OTHER";
  facet: string;
  excerpt: string;
  expected: "SUPPORTS" | "CONTRADICTS" | "CONTEXT" | "IRRELEVANT";
  evidenceEligible?: boolean;
  authority?: string;
  sourceUrl?: string;
}): QualificationCase {
  const ref = `X${digest(input.name)}`;
  const candidate = {
    ref,
    sourceRef: "S1",
    path: "record.text",
    offsetStart: 0,
    offsetEnd: input.excerpt.length,
    text: input.excerpt,
    sourceHash: digest(input.excerpt),
    sourceUrl: input.sourceUrl ?? "https://records.example/item",
    title: "Qualification record",
    provider: "qualification",
    providerRoute: "qualification.record",
    effectiveAuthority: input.authority ?? "FIRST_PARTY_INSTITUTIONAL",
    evidenceEligible: input.evidenceEligible ?? true,
  };
  const candidateSetHash = digest({ name: input.name, candidate });
  const claims = [{ claimKey: "C001", statement: input.facet, facets: [{ key: "assertion", kind: input.kind, label: input.facet }] }];
  const candidateSet = { bundleId: "B001", facets: [{ claimKey: "C001", facetKey: "assertion", candidates: [candidate] }], fingerprint: candidateSetHash, totalCharacters: input.excerpt.length, uniqueExcerpts: 1 };
  return {
    name: input.name,
    agent: "evidence-compiler",
    contract: EVIDENCE_JUDGE_PROMPT_CONTRACT,
    payload: { bundleId: "B001", candidateSetHash, claims, candidates: candidateSet.facets },
    schema: bundleEvidenceJudgmentSchema,
    semantic: (value) => {
      const valid = validateBundleEvidenceJudgment(value, "B001", claims, candidateSet, candidateSetHash, ["Casey Morgan"]);
      if (valid.dispositions[0]?.relation !== input.expected) throw new Error(`Expected ${input.expected}, received ${valid.dispositions[0]?.relation ?? "nothing"}.`);
    },
  };
}

function evidenceCases(): QualificationCase[] {
  return [
    evidenceCase({ name: "evidence-context-only-source", kind: "ORGANIZATION", facet: "Casey Morgan worked at Organization Alpha.", excerpt: "Organization Alpha publishes software engineering news.", expected: "CONTEXT", evidenceEligible: false, authority: "CONTEXT" }),
    evidenceCase({ name: "evidence-activity-is-not-status", kind: "AFFILIATION", facet: "Casey Morgan maintained Project Atlas.", excerpt: "Casey Morgan submitted pull request 123 to Project Atlas.", expected: "CONTEXT" }),
    evidenceCase({ name: "evidence-project-existence-is-not-contribution", kind: "CONTRIBUTION", facet: "Casey Morgan built Project Atlas.", excerpt: "Project Atlas is an open-source compiler project.", expected: "CONTEXT" }),
    evidenceCase({ name: "evidence-wrong-person", kind: "TITLE", facet: "Casey Morgan held the Principal Engineer title.", excerpt: "Jordan Lee held the Principal Engineer title.", expected: "IRRELEVANT" }),
    evidenceCase({ name: "evidence-temporal-progression", kind: "TITLE", facet: "Casey Morgan was a Senior Engineer in 2020.", excerpt: "Casey Morgan was promoted to Staff Engineer in 2022.", expected: "IRRELEVANT" }),
    evidenceCase({ name: "evidence-explicit-contradiction", kind: "ORGANIZATION", facet: "Casey Morgan worked at Organization Alpha in 2021.", excerpt: "Organization Alpha states that Casey Morgan did not work there in 2021.", expected: "CONTRADICTS" }),
    evidenceCase({ name: "evidence-affiliation-support", kind: "AFFILIATION", facet: "Casey Morgan belonged to Association Delta.", excerpt: "Association Delta members include Casey Morgan.", expected: "SUPPORTS" }),
    evidenceCase({ name: "evidence-employment-is-not-title", kind: "TITLE", facet: "Casey Morgan held the Principal Engineer title.", excerpt: "Casey Morgan worked at Organization Alpha.", expected: "CONTEXT" }),
    evidenceCase({ name: "evidence-multilingual-support", kind: "TITLE", facet: "Camille Martin held the Ingénieure principale title.", excerpt: "Camille Martin — Ingénieure principale.", expected: "SUPPORTS" }),
    evidenceCase({ name: "evidence-malicious-discovery-domain", kind: "ORGANIZATION", facet: "Casey Morgan worked at Organization Alpha.", excerpt: "A search result claims Casey Morgan worked at Organization Alpha.", expected: "CONTEXT", evidenceEligible: false, authority: "DISCOVERY_ONLY", sourceUrl: "https://organization-alpha.example.evil.invalid/profile" }),
  ];
}

const cleanEvidence = [{ key: "E001", claimKey: "C001", facetKeys: ["organization"], relation: "SUPPORTS", sourceRef: "S1", exactQuote: "Casey Morgan worked at Organization Alpha.", sourceLocation: { path: "record.text" } }];
const auditBase = {
  input: { pages: [{ page: 1, lines: [{ line: 1, text: "Casey Morgan worked at Organization Alpha." }] }] },
  lineCatalog: { lines: [{ id: "P1L1", text: "Casey Morgan worked at Organization Alpha." }] },
  exclusions: [],
  bundlePlan: { bundles: [{ bundleId: "B001", claimKeys: ["C001"] }] },
  packets: [{ bundleId: "B001", claims: [{ claimKey: "C001" }] }],
  claims: [{ key: "C001", statement: "Casey Morgan worked at Organization Alpha.", facets: [{ key: "organization", label: "Casey Morgan worked at Organization Alpha.", status: "SUPPORTED" }] }],
  candidateJudgments: [{ bundleId: "B001", dispositions: [] }],
  summary: { professionalIdentity: { text: "Accepted evidence resolves C001 using E001." }, limitations: [] },
  officialDomainRegistry: { schemaVersion: 1, policyVersion: "verified-domain-registry-v1", entries: [], registryHash: "a".repeat(64) },
  sourceAuthoritySnapshot: { schemaVersion: 1, policyVersion: "verified-domain-registry-v1", registryHash: "a".repeat(64), sources: [{ sourceRef: "S1", effectiveAuthority: "FIRST_PARTY_INSTITUTIONAL" }] },
};

function auditCases(): QualificationCase[] {
  const auditCase = (name: string, payload: unknown, semantic: (value: z.infer<typeof v5AuditSchema>) => void): QualificationCase => ({ name, agent: "evidence-auditor", contract: V5_AUDITOR_PROMPT_CONTRACT, payload, schema: v5AuditSchema, semantic: (value) => semantic(v5AuditSchema.parse(value)) });
  return [
    auditCase("audit-clean", { ...auditBase, evidence: cleanEvidence }, (value) => {
      if (value.status !== "PASSED" || value.defects.some(({ severity }) => severity === "MATERIAL")) throw new Error("Clean ledger was not passed.");
    }),
    auditCase("audit-single-bundle-neighboring-facet", { ...auditBase, evidence: [{ ...cleanEvidence[0], exactQuote: "Jordan Lee contributed a patch to Project Atlas." }] }, (value) => {
      const defect = value.defects.find(({ severity, stage, bundleId, repairable }) => severity === "MATERIAL" && stage === "EVIDENCE" && bundleId === "B001" && repairable);
      if (value.status !== "REPAIR_REQUIRED" || !defect) throw new Error("Single-bundle evidence defect was not scoped for repair.");
    }),
    auditCase("audit-deterministic-summary-defect", { ...auditBase, evidence: [], claims: [{ ...auditBase.claims[0], facets: [{ ...auditBase.claims[0]!.facets[0], status: "UNRESOLVED" }] }], summary: { professionalIdentity: { text: "Casey Morgan's employment is independently verified." }, limitations: [] } }, (value) => {
      const defect = value.defects.find(({ severity, stage, bundleId }) => severity === "MATERIAL" && stage === "SUMMARY" && bundleId === undefined);
      if (value.status !== "REPAIR_REQUIRED" || !defect) throw new Error("Deterministic summary defect was not isolated.");
    }),
    auditCase("audit-multi-bundle-fails-closed", {
      ...auditBase,
      bundlePlan: { bundles: [{ bundleId: "B001", claimKeys: ["C001"] }, { bundleId: "B002", claimKeys: ["C002"] }] },
      packets: [{ bundleId: "B001", claims: [{ claimKey: "C001" }] }, { bundleId: "B002", claims: [{ claimKey: "C002" }] }],
      claims: [...auditBase.claims, { key: "C002", statement: "Casey Morgan built Project Atlas.", facets: [{ key: "contribution", label: "Casey Morgan built Project Atlas.", status: "SUPPORTED" }] }],
      evidence: [{ ...cleanEvidence[0], exactQuote: "Jordan Lee worked at Organization Alpha." }, { key: "E002", claimKey: "C002", facetKeys: ["contribution"], relation: "SUPPORTS", sourceRef: "S2", exactQuote: "Project Atlas is an open-source project.", sourceLocation: { path: "record.text" } }],
    }, (value) => {
      const material = value.defects.filter(({ severity }) => severity === "MATERIAL");
      if (value.status !== "REPAIR_REQUIRED" || !material.length || material.some(({ repairable }) => repairable)) throw new Error("Multi-bundle defect did not fail closed.");
    }),
  ];
}

const cases: QualificationCase[] = [...claimCases(), ...evidenceCases(), ...auditCases()];
if (cases.length !== 20) throw new Error(`Qualification suite must contain exactly 20 cases, found ${cases.length}.`);

async function qualify(model: string, handle: RunHandle): Promise<Metrics> {
  const definition = finalizerModelDefinition(model);
  const client = createOpencodeClient({ baseUrl: handle.openCodeUrl, headers: handle.accessHeaders, throwOnError: false });
  const parent = await client.session.create({ directory, title: `V5.1 qualification ${model}`, agent: "evidence-compiler", model: { id: model, providerID: definition.providerId, variant: "medium" } });
  if (!parent.data || parent.error) throw new Error(`${model} parent session creation failed: ${JSON.stringify(parent.error ?? "missing data")}`);
  const metrics: Metrics = { model, calls: cases.length, valid: 0, firstPass: 0, repairs: 0, transportErrors: 0, semanticDefects: 0, invalid: 0, elapsedMs: 0, estimatedCostUsd: 0, qualified: false };
  const started = Date.now();
  for (const item of cases) {
    let originalResponse = "";
    let validatorError = "";
    let lastFailure: "FORMAT" | "SEMANTIC" = "FORMAT";
    let passed = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const requestPayload = attempt === 0 ? item.payload : { frozenInput: item.payload, repair: finalizerRepairPayload(originalResponse, validatorError) };
      const prompt = finalizerPromptPayload(provider, model, promptWithPayload(item.contract, requestPayload), item.schema);
      if ("format" in prompt) throw new Error("V5.1 qualification attempted native structured output.");
      try {
        const session = await client.session.create({ directory, parentID: parent.data.id, title: `${item.name}${attempt ? " repair" : ""}`, agent: item.agent, model: { id: model, providerID: definition.providerId, variant: "medium" } });
        if (!session.data || session.error) throw new Error(`session creation: ${JSON.stringify(session.error ?? "missing data")}`);
        const message = await client.session.prompt({ sessionID: session.data.id, directory, agent: item.agent, model: { providerID: definition.providerId, modelID: model }, variant: "medium", tools: { "source.excerpts": false, skill: false }, ...prompt });
        if (!message.data || message.error) throw new Error(`prompt: ${JSON.stringify(message.error ?? "missing data")}`);
        const assistant = message.data as unknown as AssistantMessage;
        if (assistant.info.error) throw new Error(`prompt: ${describeSdkError(assistant.info.error)}`);
        originalResponse = assistantText(assistant);
        const inputTokens = Math.ceil(JSON.stringify(requestPayload).length / 4);
        const outputTokens = Math.ceil(originalResponse.length / 4);
        metrics.estimatedCostUsd += (inputTokens * definition.inputUsdPerMillion + outputTokens * definition.outputUsdPerMillion) / 1_000_000;
        let parsed: unknown;
        try { parsed = item.schema.parse(extractMarkedJson(assistant)); }
        catch (error) { lastFailure = "FORMAT"; throw error; }
        try { item.semantic(parsed); }
        catch (error) { lastFailure = "SEMANTIC"; throw error; }
        metrics.valid += 1;
        if (attempt === 0) metrics.firstPass += 1;
        else metrics.repairs += 1;
        passed = true;
        break;
      } catch (error) {
        validatorError = error instanceof Error ? error.message : String(error);
        if (/^(?:session creation|prompt):/u.test(validatorError)) {
          metrics.transportErrors += 1;
          break;
        }
      }
    }
    if (!passed) {
      metrics.invalid += 1;
      if (lastFailure === "SEMANTIC") metrics.semanticDefects += 1;
      process.stderr.write(`${model} ${item.name} failed: ${validatorError}\n`);
    }
  }
  metrics.elapsedMs = Date.now() - started;
  metrics.estimatedCostUsd = Number(metrics.estimatedCostUsd.toFixed(6));
  metrics.qualified = metrics.valid === 20 && metrics.firstPass >= 19 && metrics.repairs <= 1 && metrics.transportErrors === 0 && metrics.semanticDefects === 0;
  return metrics;
}

async function listen(server: ReturnType<typeof createHeadlessGateway>["server"]): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Qualification gateway did not bind a TCP port.");
  return address.port;
}

const root = await mkdtemp(join(tmpdir(), "translucid-v5.1-qualification-"));
const runId = randomUUID();
const deadlineAt = new Date(Date.now() + 60 * 60_000);
const sourceStore = await FileSourceStore.open(root);
const budget = new MemoryRunBudget({ modelUsd: 100, providerUsd: 0, externalNetworkCalls: 0, repositoryClones: 0, socialProfiles: 0 });
const gateway = createHeadlessGateway({
  runId,
  deadlineAt: deadlineAt.getTime(),
  allowedTools: new Set(),
  allowedModels: new Set(models),
  agentTools: new Map([["evidence-compiler", new Set()], ["evidence-auditor", new Set()]]),
  sourceStore,
  budget,
  providerMode: "live",
  finalizerUpstreamUrl: provider === "GO" ? "https://opencode.ai/zen/go/v1/chat/completions" : "https://opencode.ai/zen/v1/chat/completions",
  finalizerProvider: provider,
});
const runtime = new LocalDockerRuntime();
let handle: RunHandle | undefined;
try {
  const gatewayPort = await listen(gateway.server);
  handle = await runtime.start({
    investigationId: runId,
    runId,
    caseDirectory: root,
    gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
    caseToken: gateway.token,
    openCodePassword: randomBytes(24).toString("base64url"),
    expectedManifestHash: await getPinnedLocalManifestHash(),
    timeoutMs: 60 * 60_000,
    mode: "headless",
    deadlineAt: deadlineAt.toISOString(),
  });
  const results: Metrics[] = [];
  for (const model of models) {
    process.stderr.write(`Running the exact 20-case V5.1 qualification for ${model}.\n`);
    results.push(await qualify(model, handle));
  }
  const qualifiers = results.filter(({ qualified }) => qualified).sort((left, right) => left.semanticDefects - right.semanticDefects || right.firstPass - left.firstPass || left.estimatedCostUsd - right.estimatedCostUsd || left.elapsedMs - right.elapsedMs);
  process.stdout.write(`${JSON.stringify({ suite: { claims: 6, bundleEvidence: 10, audits: 4 }, results, selectedCompiler: qualifiers[0]?.model ?? null, selectedAuditor: qualifiers[1]?.model ?? null }, null, 2)}\n`);
  if (results.some(({ qualified }) => !qualified) || (requested === "all" && qualifiers.length < 2)) process.exitCode = 1;
} finally {
  gateway.cancel();
  if (handle) await runtime.stop(handle);
  if (gateway.server.listening) await new Promise<void>((resolve) => gateway.server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
