import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { z } from "zod";

import { extractMarkedJson } from "../src/agent/structured-output.ts";
import { FINALIZER_MODEL_CATALOG, finalizerModelDefinition } from "../src/core/model-catalog.ts";
import { describeSdkError, finalizerPromptPayload, type AssistantMessage } from "../src/headless/finalization-controller.ts";
import { claimBatchSchema, evidenceJudgmentSchema, v5AuditSchema, validateClaimBatchRecords, validateEvidenceJudgment } from "../src/headless/incremental-finalization.ts";
import { buildLineCatalog } from "../src/headless/line-catalog.ts";
import { summaryTimelineOutputSchema } from "../src/headless/packet-dossier.ts";
import { CLAIM_BATCH_PROMPT_CONTRACT, EVIDENCE_JUDGE_PROMPT_CONTRACT, promptWithPayload, V5_AUDITOR_PROMPT_CONTRACT } from "../src/headless/prompt-contracts.ts";

type Case<T> = {
  name: string;
  agent: "evidence-compiler" | "evidence-auditor";
  contract: string;
  payload: unknown;
  schema: z.ZodType<T>;
  semantic: (value: T) => void;
};
type Metrics = { model: string; calls: number; valid: number; firstPass: number; repairs: number; transportErrors: number; semanticDefects: number; invalid: number; elapsedMs: number; estimatedCostUsd: number; qualified: boolean };

const argumentsList = process.argv.slice(2);
const runId = argumentsList.find((value) => /^[0-9a-f-]{36}$/iu.test(value));
if (!runId) throw new Error("Usage: npm run smoke:finalizer -- <active-local-run-id> [--models all|model,model]");
const modelsIndex = argumentsList.indexOf("--models");
const requested = modelsIndex >= 0 ? argumentsList[modelsIndex + 1] : process.env.FINALIZER_MODEL ?? "mimo-v2.5-pro";
if (!requested) throw new Error("--models requires a value.");
const models = requested === "all" ? FINALIZER_MODEL_CATALOG.map(({ id }) => id) : requested.split(",").map((value) => value.trim()).filter(Boolean);
for (const model of models) finalizerModelDefinition(model);
const provider = process.env.FINALIZER_OPENCODE_PROVIDER === "ZEN" ? "ZEN" : "GO";
const directory = "/workspace/case";

async function attachDetails(): Promise<{ openCodeUrl: string; password: string }> {
  for (const path of [resolve(".debug", "headless", `${runId}.json`), resolve(".debug", "attach", `${runId}.json`)]) {
    try { return JSON.parse(await readFile(path, "utf8")) as { openCodeUrl: string; password: string }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  throw new Error(`No active local OpenCode attachment was found for ${runId}.`);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assistantText(message: AssistantMessage): string {
  return message.parts.flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("").trim();
}

function claimCases(): Array<Case<z.infer<typeof claimBatchSchema>>> {
  const lines = [
    "Diego Russo is the named professional.",
    "Diego Russo works as a Principal Software Engineer at Arm.",
    "Diego Russo contributed patches to CPython.",
    "Diego Russo organized EuroPython 2024.",
    "Diego Russo earned an MSc in Computer Science.",
  ];
  return lines.map((text, index) => {
    const catalog = buildLineCatalog({ pages: [{ page: 1, lines: [{ line: 1, text }] }] });
    const lineIds = catalog.lines.filter(({ layout }) => layout === "SEMANTIC").map(({ id }) => id);
    return {
      name: `claim-${index + 1}`,
      agent: "evidence-compiler",
      contract: CLAIM_BATCH_PROMPT_CONTRACT,
      payload: { contextLines: [], lineWindow: catalog.lines, acceptedClaims: [] },
      schema: claimBatchSchema,
      semantic: (value) => {
        const valid = validateClaimBatchRecords(value, catalog, lineIds);
        if (valid.defects.length || valid.unresolvedLineIds.length || valid.claims.length !== 1 || valid.exclusions.length || valid.deferredLineIds.length) throw new Error(`The factual line was not compiled into exactly one valid claim: ${valid.defects.join("; ")}`);
      },
    };
  });
}

function evidenceCases(): Array<Case<z.infer<typeof evidenceJudgmentSchema>>> {
  const fixtures: Array<{ name: string; facet: string; excerpt: string; expected: "SUPPORTS" | "IRRELEVANT" }> = [
    { name: "cpython-pr-is-not-core-status", facet: "Diego Russo is a CPython core developer.", excerpt: "Diego Russo authored CPython pull request 12345.", expected: "IRRELEVANT" },
    { name: "mlia-commit-is-not-arm-employment", facet: "Diego Russo was employed by Arm.", excerpt: "Commit abc123 in the MLIA repository was authored by Diego Russo.", expected: "IRRELEVANT" },
    { name: "mlia-commit-is-not-arm-title", facet: "Diego Russo held the title Principal Software Engineer at Arm.", excerpt: "Commit abc123 in the MLIA repository was authored by Diego Russo.", expected: "IRRELEVANT" },
    { name: "jit-work-is-not-europython-role", facet: "Diego Russo organized EuroPython.", excerpt: "Diego Russo implemented a CPython JIT optimization.", expected: "IRRELEVANT" },
    { name: "jit-work-is-not-python-guild-role", facet: "Diego Russo led the Arm Python Guild.", excerpt: "Diego Russo implemented a CPython JIT optimization.", expected: "IRRELEVANT" },
    { name: "resume-is-not-independent", facet: "An independent source confirms Diego Russo's Arm employment.", excerpt: "Candidate résumé self-representation: I work at Arm.", expected: "IRRELEVANT" },
    { name: "progression-is-not-contradiction", facet: "Diego Russo was a Senior Engineer in 2018.", excerpt: "Diego Russo was promoted to Staff Engineer in 2022.", expected: "IRRELEVANT" },
    { name: "official-core-team-support", facet: "Diego Russo is a CPython core developer.", excerpt: "Python core team member: Diego Russo.", expected: "SUPPORTS" },
    { name: "official-arm-title-support", facet: "Diego Russo is a Principal Software Engineer at Arm.", excerpt: "Diego Russo, Principal Software Engineer, Arm.", expected: "SUPPORTS" },
    { name: "official-europython-support", facet: "Diego Russo organized EuroPython 2024.", excerpt: "EuroPython 2024 organizers: Diego Russo.", expected: "SUPPORTS" },
  ];
  return fixtures.map((fixture, index) => {
    const excerpt = { ref: `X${digest(fixture.name)}`, sourceRef: "S1", path: `records[${index}].text`, offsetStart: 0, offsetEnd: fixture.excerpt.length, text: fixture.excerpt };
    const candidateSetHash = digest({ fixture: fixture.name, excerpt });
    const claim = { claimKey: "C001", facets: [{ key: "assertion" }] };
    const candidates = new Map([["assertion", [excerpt]]]);
    return {
      name: fixture.name,
      agent: "evidence-compiler",
      contract: EVIDENCE_JUDGE_PROMPT_CONTRACT,
      payload: { claim: { claimId: "C001", statement: fixture.facet, facets: [{ key: "assertion", statement: fixture.facet }] }, candidateSetHash, candidatesByFacet: { assertion: [excerpt] } },
      schema: evidenceJudgmentSchema,
      semantic: (value) => {
        const valid = validateEvidenceJudgment(value, claim, candidates, candidateSetHash);
        if (valid.facets[0]?.candidates[0]?.relation !== fixture.expected) throw new Error(`Expected ${fixture.expected} for the gold fixture.`);
      },
    };
  });
}

const summaryPayload = {
  input: { pages: [{ page: 1, lines: [{ line: 1, text: "Diego Russo works at Arm." }] }] },
  claims: [{ claimKey: "C001", statement: "Diego Russo works at Arm.", facets: [{ key: "employer", label: "Diego Russo works at Arm.", materiality: "HIGH" }] }],
  evidence: [{ key: "E001", claimKey: "C001", facetKeys: ["employer"], relation: "SUPPORTS", sourceRef: "S1", exactQuote: "Diego Russo works at Arm.", sourceLocation: { path: "record.text" } }],
};

function summaryCases(): Array<Case<z.infer<typeof summaryTimelineOutputSchema>>> {
  return Array.from({ length: 3 }, (_, index) => ({
    name: `summary-${index + 1}`,
    agent: "evidence-compiler" as const,
    contract: "MODE: SUMMARY_TIMELINE\n\nWrite narrative only from the supplied claim and evidence keys. Do not add facts.",
    payload: summaryPayload,
    schema: summaryTimelineOutputSchema,
    semantic: (value: z.infer<typeof summaryTimelineOutputSchema>) => {
      const unknown = (JSON.stringify(value).match(/\b[CE]\d{3}\b/gu) ?? []).find((key) => key !== "C001" && key !== "E001");
      if (unknown) throw new Error(`Summary fabricated unknown key ${unknown}.`);
    },
  }));
}

function auditCases(): Array<Case<z.infer<typeof v5AuditSchema>>> {
  const base = { input: summaryPayload.input, claims: summaryPayload.claims, candidateJudgments: [], summary: { note: "Only C001 and E001 are referenced." } };
  return [
    {
      name: "audit-clean",
      agent: "evidence-auditor",
      contract: V5_AUDITOR_PROMPT_CONTRACT,
      payload: { ...base, evidence: summaryPayload.evidence },
      schema: v5AuditSchema,
      semantic: (value) => { if (value.status !== "PASSED" || value.defects.some(({ severity }) => severity === "MATERIAL")) throw new Error("Clean audit fixture was not passed."); },
    },
    {
      name: "audit-adjacent-facet",
      agent: "evidence-auditor",
      contract: V5_AUDITOR_PROMPT_CONTRACT,
      payload: { ...base, evidence: [{ ...summaryPayload.evidence[0], exactQuote: "Diego Russo authored a CPython pull request." }] },
      schema: v5AuditSchema,
      semantic: (value) => {
        const defect = value.defects.find(({ severity, stage, claimKeys, repairable }) => severity === "MATERIAL" && stage === "EVIDENCE" && claimKeys.includes("C001") && repairable);
        if (value.status !== "REPAIR_REQUIRED" || !defect) throw new Error("Auditor missed the adjacent-facet evidence defect.");
      },
    },
  ];
}

const cases: Array<Case<unknown>> = [...claimCases(), ...evidenceCases(), ...summaryCases(), ...auditCases()];
if (cases.length !== 20) throw new Error(`Qualification suite must contain exactly 20 cases, found ${cases.length}.`);

async function qualify(model: string, attach: { openCodeUrl: string; password: string }): Promise<Metrics> {
  const definition = finalizerModelDefinition(model);
  const client = createOpencodeClient({ baseUrl: attach.openCodeUrl, headers: { authorization: `Basic ${Buffer.from(`opencode:${attach.password}`).toString("base64")}` }, throwOnError: false });
  const parent = await client.session.create({ directory, title: `V5 qualification ${model}`, agent: "evidence-compiler", model: { id: model, providerID: definition.providerId, variant: "medium" } });
  if (!parent.data || parent.error) throw new Error(`${model} parent session creation failed: ${JSON.stringify(parent.error ?? "missing data")}`);
  const metrics: Metrics = { model, calls: cases.length, valid: 0, firstPass: 0, repairs: 0, transportErrors: 0, semanticDefects: 0, invalid: 0, elapsedMs: 0, estimatedCostUsd: 0, qualified: false };
  const started = Date.now();
  for (const item of cases) {
    let originalResponse = "";
    let validatorError = "";
    let lastFailure: "FORMAT" | "SEMANTIC" = "FORMAT";
    let passed = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const requestPayload = attempt === 0 ? item.payload : { originalPayload: item.payload, originalResponse, validatorError, repairInstruction: "Correct only the exact validator defect and return the complete requested object." };
      const prompt = finalizerPromptPayload(provider, model, promptWithPayload(item.contract, requestPayload), item.schema);
      if ("format" in prompt) throw new Error("V5 qualification attempted native structured output.");
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
  metrics.qualified = metrics.valid === 20 && metrics.firstPass >= 19 && metrics.transportErrors === 0 && metrics.semanticDefects === 0;
  return metrics;
}

const attach = await attachDetails();
const results: Metrics[] = [];
for (const model of models) {
  process.stderr.write(`Running 20-call V5 qualification for ${model}.\n`);
  results.push(await qualify(model, attach));
}
const qualifiers = results.filter(({ qualified }) => qualified).sort((left, right) => left.semanticDefects - right.semanticDefects || right.firstPass - left.firstPass || left.estimatedCostUsd - right.estimatedCostUsd || left.elapsedMs - right.elapsedMs);
process.stdout.write(`${JSON.stringify({ results, selectedCompiler: qualifiers[0]?.model ?? null, selectedAuditor: qualifiers[1]?.model ?? null }, null, 2)}\n`);
if (results.some(({ qualified }) => !qualified) || (requested === "all" && qualifiers.length < 2)) process.exitCode = 1;
