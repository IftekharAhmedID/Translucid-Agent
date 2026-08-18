import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import type { FileSourceStore } from "./source-store.ts";

export const sourceRefSchema = z.string().regex(/^S[1-9]\d*$/);

export const pdfTextAnchorSchema = z.object({
  kind: z.literal("PDF_TEXT"),
  page: z.number().int().positive(),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  exact: z.string().trim().min(1).max(6_000),
}).strict().refine(({ lineStart, lineEnd }) => lineEnd >= lineStart, { path: ["lineEnd"], message: "lineEnd must be greater than or equal to lineStart." });

export const discoveredAnchorSchema = z.object({
  kind: z.literal("DISCOVERED"),
  basis: z.string().trim().min(1).max(2_000),
}).strict();

export const targetAnchorSchema = z.discriminatedUnion("kind", [pdfTextAnchorSchema, discoveredAnchorSchema]);

export const investigationTargetSchema = z.object({
  id: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  section: z.string().trim().min(1).max(200),
  predicate: z.string().trim().min(1).max(6_000),
  importance: z.enum(["HIGH", "MEDIUM"]),
  anchor: targetAnchorSchema,
}).strict();

export const investigationEvidenceSchema = z.object({
  sourceRef: sourceRefSchema,
  relation: z.enum(["SUPPORTS", "CONTRADICTS", "CONTEXT"]),
  comment: z.string().trim().min(1).max(6_000),
}).strict();

export const canonicalFindingStatusSchema = z.enum(["ESTABLISHED", "PARTIAL", "UNRESOLVED", "CONFLICTING", "CONTRADICTED"]);

export const investigationFindingSchema = z.object({
  targetId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  conclusion: z.string().trim().min(1).max(6_000),
  status: canonicalFindingStatusSchema,
  evidence: z.array(investigationEvidenceSchema).max(200),
  rationale: z.string().trim().min(1).max(12_000),
  remainingGap: z.string().trim().max(2_000).nullable(),
}).strict();

export const investigationSummarySchema = z.object({
  text: z.string().trim().min(1).max(50_000),
  targetIds: z.array(z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)).max(500),
}).strict().superRefine(({ targetIds }, context) => {
  if (new Set(targetIds).size !== targetIds.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["targetIds"], message: "Summary target IDs must be unique." });
});

export const researchClaimSchema = z.object({
  id: z.string().trim().min(1).max(100),
  claim: z.string().trim().min(1).max(6_000),
  provisionalStatus: z.enum(["established", "provisional", "conflicting", "unresolved"]),
  supportingRefs: z.array(sourceRefSchema).max(200),
  conflictingRefs: z.array(sourceRefSchema).max(200),
  remainingGap: z.string().trim().max(2_000).nullable(),
  importance: z.string().trim().min(1).max(100),
}).strict();

export const researchStateInputSchema = z.object({
  publicationReady: z.boolean(),
  claims: z.array(researchClaimSchema).min(1).max(500),
  identityAnchors: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
}).strict().superRefine(({ claims }, context) => {
  const ids = new Set<string>();
  for (const claim of claims) {
    if (ids.has(claim.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["claims"], message: `Claim IDs must be unique; duplicate ${claim.id}.` });
    ids.add(claim.id);
  }
});

const researchStateV1Schema = z.object({
  schemaVersion: z.literal(1),
  updatedAt: z.string().min(1),
  identityAnchors: z.array(z.string().min(1).max(500)).max(100),
  sourceRefs: z.array(sourceRefSchema).max(10_000),
  attemptedRoutes: z.array(z.string().min(1).max(200)).max(1_000),
  claims: z.array(researchClaimSchema).min(1).max(500),
}).strict();

const researchStateV2Schema = researchStateV1Schema.extend({
  schemaVersion: z.literal(2),
  publicationReady: z.boolean(),
}).strict();

export const researchStateV3Schema = z.object({
  schemaVersion: z.literal(3),
  revision: z.number().int().nonnegative(),
  phase: z.enum(["RESEARCHING", "SYNTHESIZING", "COMMITTED"]),
  updatedAt: z.string().min(1),
  committedAt: z.string().min(1).nullable(),
  identityAnchors: z.array(z.string().trim().min(1).max(500)).max(100),
  targets: z.array(investigationTargetSchema).min(1).max(500),
  findings: z.array(investigationFindingSchema).max(500),
  summary: investigationSummarySchema.nullable(),
  sourceRefs: z.array(sourceRefSchema).max(10_000),
  attemptedRoutes: z.array(z.string().trim().min(1).max(200)).max(1_000),
}).strict().superRefine(({ targets, findings, summary }, context) => {
  const targetIds = new Set<string>();
  for (const target of targets) {
    if (targetIds.has(target.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["targets"], message: `Target IDs must be unique; duplicate ${target.id}.` });
    targetIds.add(target.id);
  }
  const findingIds = new Set<string>();
  for (const finding of findings) {
    if (findingIds.has(finding.targetId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["findings"], message: `Only one finding may exist per target; duplicate ${finding.targetId}.` });
    findingIds.add(finding.targetId);
    if (!targetIds.has(finding.targetId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["findings"], message: `Finding references unknown target ${finding.targetId}.` });
    validateFindingInvariants(finding, context, ["findings", findings.indexOf(finding)]);
  }
  if (summary) {
    for (const id of summary.targetIds) if (!targetIds.has(id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["summary", "targetIds"], message: `Summary references unknown target ${id}.` });
  }
});

const researchStateSchema = z.union([researchStateV1Schema, researchStateV2Schema, researchStateV3Schema]);

const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  research: z.object({
    artifacts: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    config: z.object({ runtime: z.enum(["LOCAL", "E2B"]), researchModel: z.string().min(1), leadSessionId: z.string().min(1).optional() }).loose(),
    completedAt: z.string().min(1),
  }).strict(),
}).strict();

export type ResearchClaim = z.infer<typeof researchClaimSchema>;
export type ResearchStateV3 = z.infer<typeof researchStateV3Schema>;
type ParsedResearchState = z.infer<typeof researchStateSchema>;
// Keep the public state type source-compatible with v1/v2 callers while exposing
// the v3 fields to new consumers. Runtime callers must still narrow by
// schemaVersion before using a field that is not present in their version.
export type ResearchState = ParsedResearchState & {
  publicationReady?: boolean;
  claims: ResearchClaim[];
  revision: number;
  phase: ResearchStateV3["phase"];
  committedAt: string | null;
  targets: ResearchStateV3["targets"];
  findings: ResearchStateV3["findings"];
  summary: ResearchStateV3["summary"];
};

export class ResearchStateError extends Error {
  constructor(readonly code: string, message: string, readonly field?: string) {
    super(message);
    this.name = "ResearchStateError";
  }
}

function validateFindingInvariants(finding: z.infer<typeof investigationFindingSchema>, context: z.RefinementCtx, path: (string | number)[]): void {
  const supporting = finding.evidence.filter(({ relation }) => relation === "SUPPORTS").length;
  const contradicting = finding.evidence.filter(({ relation }) => relation === "CONTRADICTS").length;
  if (finding.status === "ESTABLISHED" && (supporting < 1 || finding.remainingGap !== null)) context.addIssue({ code: z.ZodIssueCode.custom, path, message: "ESTABLISHED requires SUPPORTS evidence and a null remainingGap." });
  if (finding.status === "PARTIAL" && (supporting < 1 || !finding.remainingGap)) context.addIssue({ code: z.ZodIssueCode.custom, path, message: "PARTIAL requires SUPPORTS evidence and a non-empty remainingGap." });
  if (finding.status === "UNRESOLVED" && !finding.remainingGap) context.addIssue({ code: z.ZodIssueCode.custom, path, message: "UNRESOLVED requires a non-empty remainingGap." });
  if (finding.status === "CONFLICTING" && (supporting < 1 || contradicting < 1)) context.addIssue({ code: z.ZodIssueCode.custom, path, message: "CONFLICTING requires SUPPORTS and CONTRADICTS evidence." });
  if (finding.status === "CONTRADICTED" && contradicting < 1) context.addIssue({ code: z.ZodIssueCode.custom, path, message: "CONTRADICTED requires CONTRADICTS evidence." });
}

export function statusToNumeric(status: z.infer<typeof canonicalFindingStatusSchema>): -2 | -1 | 0 | 1 | 2 {
  return ({ ESTABLISHED: 2, PARTIAL: 1, UNRESOLVED: 0, CONFLICTING: -1, CONTRADICTED: -2 } as const)[status];
}

export function knownResearchPredicateIds(state: ResearchState): string[] {
  if (state.schemaVersion === 3) return state.targets.map(({ id }) => id);
  return state.claims.map(({ id }) => id);
}

export type ResearchStatePage = {
  state: (ResearchState & { claims: ResearchClaim[] }) | null;
  nextCursor: string | null;
};

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sortedRefs(refs: Iterable<string>): string[] {
  return [...new Set(refs)].sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

type V3PlanInput = {
  identityAnchors?: string[];
  targets: Array<z.infer<typeof investigationTargetSchema>>;
};

const v3PlanInputSchema = z.object({
  identityAnchors: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  targets: z.array(investigationTargetSchema).min(1).max(500),
}).strict();

const v3TargetAddInputSchema = z.object({ target: investigationTargetSchema }).strict();

const v3SummaryInputSchema = investigationSummarySchema;

const now = (): string => new Date().toISOString();

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new ResearchStateError("INVALID_INPUT", issue?.message ?? "Invalid investigation state input.", issue?.path.join("."));
}

export class ResearchStateStore {
  private state: ResearchState | undefined;
  private readonly attemptedRoutes = new Set<string>();
  private pending: Promise<void> = Promise.resolve();
  private pendingFailure: unknown;

  private constructor(private readonly root: string, private readonly sourceStore: FileSourceStore, state?: ResearchState, private readonly legacy = false) {
    this.state = state;
    for (const route of state?.attemptedRoutes ?? []) this.attemptedRoutes.add(route);
  }

  static async open(rootPath: string, sourceStore: FileSourceStore): Promise<ResearchStateStore> {
    const root = resolve(rootPath);
    let state: ResearchState | undefined;
    let legacy = false;
    try {
      const parsed = researchStateSchema.parse(JSON.parse(await readFile(join(root, ".work", "research-state.json"), "utf8")));
      state = (parsed.schemaVersion === 3
        ? parsed
        : { ...parsed, publicationReady: parsed.schemaVersion === 2 ? parsed.publicationReady : false }) as ResearchState;
      legacy = parsed.schemaVersion === 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") state = undefined;
    }
    return new ResearchStateStore(root, sourceStore, state, legacy);
  }

  recordRoute(route: string): void {
    if (route.trim()) this.attemptedRoutes.add(route.trim().slice(0, 200));
  }

  private assertV3Mutable(allowedPhases: Array<ResearchStateV3["phase"]>): ResearchStateV3 {
    if (!this.state) throw new ResearchStateError("STATE_REQUIRED", "Initialize the investigation plan before mutating v3 state.");
    if (this.state.schemaVersion !== 3) throw new ResearchStateError("LEGACY_STATE_READ_ONLY", "Legacy v1/v2 research ledgers are inspectable but cannot be upgraded in place.");
    if (!allowedPhases.includes(this.state.phase)) throw new ResearchStateError("INVALID_PHASE", `This operation is not allowed while the investigation is ${this.state.phase}.`, "phase");
    return this.state;
  }

  private async validatePdfAnchor(anchor: z.infer<typeof pdfTextAnchorSchema>): Promise<void> {
    let document: { pages?: Array<{ page?: number; lines?: Array<{ line?: number; text?: string }> }> };
    try {
      document = JSON.parse(await readFile(join(this.root, "input", "document.json"), "utf8")) as typeof document;
    } catch {
      throw new ResearchStateError("INVALID_ANCHOR", "The résumé document is unavailable for PDF_TEXT anchor validation.", "anchor");
    }
    const page = document.pages?.find((candidate) => candidate.page === anchor.page);
    const lines = page?.lines?.filter((line) => typeof line.line === "number" && line.line >= anchor.lineStart && line.line <= anchor.lineEnd) ?? [];
    const expected = anchor.lineEnd - anchor.lineStart + 1;
    if (lines.length !== expected || !normalizeText(lines.map((line) => line.text ?? "").join("\n")).includes(normalizeText(anchor.exact))) {
      throw new ResearchStateError("INVALID_ANCHOR", "anchor.exact was not found in the specified résumé page and line range.", "anchor.exact");
    }
  }

  private async validateTargetAnchor(target: z.infer<typeof investigationTargetSchema>): Promise<void> {
    if (target.anchor.kind === "PDF_TEXT") await this.validatePdfAnchor(target.anchor);
  }

  private async validateEvidence(evidence: Array<z.infer<typeof investigationEvidenceSchema>>): Promise<void> {
    const sources = new Map((await this.sourceStore.list()).map((source) => [source.ref, source]));
    const duplicateRefs = evidence.map(({ sourceRef }) => sourceRef).filter((ref, index, refs) => refs.indexOf(ref) !== index);
    if (duplicateRefs.length) throw new ResearchStateError("DUPLICATE_SOURCE_REFERENCE", `Finding evidence references duplicate source(s): ${sortedRefs(duplicateRefs).join(", ")}.`, "evidence");
    for (const item of evidence) {
      const source = sources.get(item.sourceRef);
      if (!source) throw new ResearchStateError("UNKNOWN_SOURCE", `Source reference ${item.sourceRef} does not exist in this run.`, "evidence");
      if (source.kind === "SEARCH_DISCOVERY") throw new ResearchStateError("INELIGIBLE_SOURCE", `Search discovery source ${item.sourceRef} cannot support a finding.`, "evidence");
    }
  }

  private enqueueWrite(next: ResearchStateV3): Promise<void> {
    const operation = this.pending.then(async () => {
      await atomicWrite(join(this.root, ".work", "research-state.json"), next);
      this.state = next as ResearchState;
      this.pendingFailure = undefined;
    });
    this.pending = operation.catch((error) => { this.pendingFailure = error; });
    return operation;
  }

  async planSet(input: unknown): Promise<{ ok: true; targetCount: number; revision: number }> {
    if (this.state) {
      if (this.state.schemaVersion !== 3) throw new ResearchStateError("LEGACY_STATE_READ_ONLY", "Legacy v1/v2 research ledgers are inspectable but cannot be upgraded in place.");
      if (this.state.targets.length) throw new ResearchStateError("PLAN_IMMUTABLE", "The investigation plan is already established and cannot be rewritten.", "targets");
      this.assertV3Mutable(["RESEARCHING"]);
    }
    const value = parseInput(v3PlanInputSchema, input) as V3PlanInput;
    const ids = new Set<string>();
    for (const target of value.targets) {
      if (ids.has(target.id)) throw new ResearchStateError("DUPLICATE_TARGET", `Target ID ${target.id} is duplicated.`, "targets");
      ids.add(target.id);
      await this.validateTargetAnchor(target);
    }
    const sourceRefs = sortedRefs((await this.sourceStore.list()).map(({ ref }) => ref));
    const next = researchStateV3Schema.parse({
      schemaVersion: 3,
      revision: this.state?.schemaVersion === 3 ? this.state.revision + 1 : 0,
      phase: "RESEARCHING",
      updatedAt: now(),
      committedAt: null,
      identityAnchors: [...new Set(value.identityAnchors ?? [])],
      targets: value.targets,
      findings: [],
      summary: null,
      sourceRefs,
      attemptedRoutes: [...this.attemptedRoutes].sort(),
    });
    await this.enqueueWrite(next);
    return { ok: true, targetCount: next.targets.length, revision: next.revision };
  }

  async targetAdd(input: unknown): Promise<{ ok: true; targetId: string; revision: number }> {
    const { target } = parseInput(v3TargetAddInputSchema, input);
    const current = this.assertV3Mutable(["RESEARCHING", "SYNTHESIZING"]);
    if (current.targets.some(({ id }) => id === target.id)) throw new ResearchStateError("DUPLICATE_TARGET", `Target ID ${target.id} already exists.`, "target.id");
    await this.validateTargetAnchor(target);
    const next = researchStateV3Schema.parse({ ...current, revision: current.revision + 1, updatedAt: now(), targets: [...current.targets, target], attemptedRoutes: [...this.attemptedRoutes].sort() });
    await this.enqueueWrite(next);
    return { ok: true, targetId: target.id, revision: next.revision };
  }

  async beginSynthesis(): Promise<{ ok: true; phase: "SYNTHESIZING"; revision: number }> {
    const current = this.assertV3Mutable(["RESEARCHING"]);
    const next = researchStateV3Schema.parse({ ...current, phase: "SYNTHESIZING", revision: current.revision + 1, updatedAt: now() });
    await this.enqueueWrite(next);
    return { ok: true, phase: "SYNTHESIZING", revision: next.revision };
  }

  async upsertFinding(input: unknown): Promise<{ ok: true; targetId: string; revision: number }> {
    const finding = parseInput(investigationFindingSchema, input);
    const current = this.assertV3Mutable(["SYNTHESIZING"]);
    if (!current.targets.some(({ id }) => id === finding.targetId)) throw new ResearchStateError("UNKNOWN_TARGET", `Finding references unknown target ${finding.targetId}.`, "targetId");
    await this.validateEvidence(finding.evidence);
    const findings = [...current.findings];
    const index = findings.findIndex(({ targetId }) => targetId === finding.targetId);
    if (index >= 0) findings[index] = finding;
    else findings.push(finding);
    const next = researchStateV3Schema.parse({ ...current, findings, revision: current.revision + 1, updatedAt: now() });
    await this.enqueueWrite(next);
    return { ok: true, targetId: finding.targetId, revision: next.revision };
  }

  async progress(): Promise<ResearchStateV3 | null> {
    const current = await this.current();
    return current?.schemaVersion === 3 ? current : null;
  }

  async setSummary(input: unknown): Promise<{ ok: true; revision: number }> {
    const summary = parseInput(v3SummaryInputSchema, input);
    const current = this.assertV3Mutable(["SYNTHESIZING"]);
    const known = new Set(current.targets.map(({ id }) => id));
    const unknown = summary.targetIds.filter((id) => !known.has(id));
    if (unknown.length) throw new ResearchStateError("UNKNOWN_TARGET", `Summary references unknown target(s): ${unknown.join(", ")}.`, "targetIds");
    const next = researchStateV3Schema.parse({ ...current, summary, revision: current.revision + 1, updatedAt: now() });
    await this.enqueueWrite(next);
    return { ok: true, revision: next.revision };
  }

  async sealHostInventory(): Promise<{ ok: true; revision: number }> {
    const current = this.state?.schemaVersion === 3 ? this.state : undefined;
    if (!current) throw new ResearchStateError("STATE_REQUIRED", "A v3 investigation state is required before sealing host inventory.");
    if (current.phase === "COMMITTED") return { ok: true, revision: current.revision };
    const sourceRefs = sortedRefs((await this.sourceStore.list()).map(({ ref }) => ref));
    const next = researchStateV3Schema.parse({ ...current, sourceRefs, attemptedRoutes: [...this.attemptedRoutes].sort(), revision: current.revision + 1, updatedAt: now() });
    await this.enqueueWrite(next);
    return { ok: true, revision: next.revision };
  }

  async validateCommit(): Promise<ResearchStateV3> {
    const current = this.assertV3Mutable(["SYNTHESIZING"]);
    const targetIds = new Set(current.targets.map(({ id }) => id));
    const findingIds = new Set(current.findings.map(({ targetId }) => targetId));
    const missing = current.targets.filter(({ id }) => !findingIds.has(id)).map(({ id }) => id);
    if (missing.length) throw new ResearchStateError("INCOMPLETE_FINDINGS", `Every target requires a finding before commit; missing target disposition(s): ${missing.join(", ")}.`, "findings");
    if (!current.summary) throw new ResearchStateError("SUMMARY_REQUIRED", "Set the investigation summary before commit.", "summary");
    const uncoveredHigh = current.targets.filter(({ id, importance }) => importance === "HIGH" && !current.summary!.targetIds.includes(id)).map(({ id }) => id);
    if (uncoveredHigh.length) throw new ResearchStateError("SUMMARY_COVERAGE_REQUIRED", `Summary must cover every HIGH target; missing ${uncoveredHigh.join(", ")}.`, "summary.targetIds");
    if (current.summary.targetIds.some((id) => !targetIds.has(id))) throw new ResearchStateError("UNKNOWN_TARGET", "Summary contains an unknown target.", "summary.targetIds");
    for (const finding of current.findings) await this.validateEvidence(finding.evidence);
    return structuredClone(current);
  }

  async commit(): Promise<{ ok: true; revision: number }> {
    const current = await this.validateCommit();
    const next = researchStateV3Schema.parse({ ...current, phase: "COMMITTED", committedAt: now(), revision: current.revision + 1, updatedAt: now() });
    await this.enqueueWrite(next);
    return { ok: true, revision: next.revision };
  }

  async set(input: unknown): Promise<{ ok: true; claimCount: number; sourceRefs: string[] }> {
    if (this.legacy) throw new Error("Legacy research ledgers are read-only and cannot be rewritten.");
    const value = researchStateInputSchema.parse(input);
    const sourceRefs = sortedRefs((await this.sourceStore.list()).map(({ ref }) => ref));
    const known = new Set(sourceRefs);
    const referenced = value.claims.flatMap(({ supportingRefs, conflictingRefs }) => [...supportingRefs, ...conflictingRefs]);
    const unknown = sortedRefs(referenced.filter((ref) => !known.has(ref)));
    if (unknown.length) throw new Error(`Research state references unknown source(s): ${unknown.join(", ")}.`);
    const next = researchStateV2Schema.parse({
      schemaVersion: 2,
      updatedAt: new Date().toISOString(),
      publicationReady: value.publicationReady,
      identityAnchors: [...new Set(value.identityAnchors)],
      sourceRefs,
      attemptedRoutes: [...this.attemptedRoutes].sort(),
      claims: value.claims.map((claim) => ({ ...claim, supportingRefs: sortedRefs(claim.supportingRefs), conflictingRefs: sortedRefs(claim.conflictingRefs) })),
    });
    const operation = this.pending.then(async () => {
      await atomicWrite(join(this.root, ".work", "research-state.json"), next);
      this.state = next as ResearchState;
      this.pendingFailure = undefined;
    });
    this.pending = operation.catch((error) => { this.pendingFailure = error; });
    await operation;
    return { ok: true, claimCount: next.claims.length, sourceRefs: next.sourceRefs };
  }

  async current(): Promise<ResearchState | undefined> {
    await this.pending;
    if (this.pendingFailure) throw this.pendingFailure;
    return this.state ? structuredClone(this.state) : undefined;
  }

  async hasValidState(): Promise<boolean> {
    const state = await this.current();
    return Boolean(state && state.schemaVersion === 2);
  }

  async isPublicationReady(): Promise<boolean> {
    const state = await this.current();
    return Boolean(state && state.schemaVersion === 2 && state.publicationReady);
  }

  async get(input: { cursor?: string; limit?: number } = {}): Promise<ResearchStatePage> {
    const state = await this.current();
    if (!state) return { state: null, nextCursor: null };
    const limit = Math.min(Math.max(Math.floor(input.limit ?? 25), 1), 25);
    const start = input.cursor ? state.claims.findIndex(({ id }) => id === input.cursor) + 1 : 0;
    if (input.cursor && start === 0) throw new Error(`Unknown research-state cursor ${input.cursor}.`);
    const claims = state.claims.slice(start, start + limit);
    const nextCursor = start + limit < state.claims.length ? claims.at(-1)?.id ?? null : null;
    return { state: { ...structuredClone(state), claims }, nextCursor };
  }

  async refresh(): Promise<void> {
    await this.pending;
    if (!this.state) return;
    if (this.state.schemaVersion !== 2) return;
    const sourceRefs = sortedRefs((await this.sourceStore.list()).map(({ ref }) => ref));
    const next = researchStateV2Schema.parse({
      ...this.state,
      updatedAt: new Date().toISOString(),
      sourceRefs,
      attemptedRoutes: [...this.attemptedRoutes].sort(),
    });
    const operation = this.pending.then(async () => {
      await atomicWrite(join(this.root, ".work", "research-state.json"), next);
      this.state = next as ResearchState;
      this.pendingFailure = undefined;
    });
    this.pending = operation.catch((error) => { this.pendingFailure = error; });
    await operation;
  }
}

async function snapshotFiles(root: string, sourceStore: FileSourceStore): Promise<string[]> {
  const inputManifestPath = join(root, "input", "manifest.json");
  const inputManifest = JSON.parse(await readFile(inputManifestPath, "utf8")) as { inputs?: Array<{ relativePath?: unknown }> };
  const inputFiles = Array.isArray(inputManifest.inputs)
    ? inputManifest.inputs.flatMap(({ relativePath }) => typeof relativePath === "string" ? [relativePath] : [])
    : [];
  for (const path of inputFiles) {
    const absolute = resolve(root, path);
    if (absolute === root || !absolute.startsWith(`${root}/`)) throw new Error(`Input artifact path escapes the run: ${path}.`);
  }
  const required = ["input/manifest.json", "input/document.json", "input/document.txt", "sources/manifest.json", ".work/research-state.json", ...inputFiles];
  // Excerpts are a mutable, derived local-recall cache: publication may add
  // new excerpts after the research freeze. The immutable source blobs and
  // manifest are the recovery boundary, so do not hash this cache into the
  // research snapshot.
  const optional = ["sources/requests.jsonl"];
  const sources = await sourceStore.list();
  const blobPaths = sources.map(({ relativePath }) => relativePath);
  const files = [...required, ...optional, ...blobPaths];
  const present: string[] = [];
  for (const path of files) {
    try {
      await readFile(join(root, path));
      present.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || required.includes(path)) throw error;
    }
  }
  return [...new Set(present)].sort();
}

export async function writeResearchSnapshot(rootPath: string, config: { runtime: "LOCAL" | "E2B"; researchModel: string; leadSessionId?: string }, sourceStore: FileSourceStore): Promise<string> {
  const root = resolve(rootPath);
  const state = await readFile(join(root, ".work", "research-state.json"), "utf8");
  researchStateSchema.parse(JSON.parse(state));
  const files = await snapshotFiles(root, sourceStore);
  const artifacts = Object.fromEntries(await Promise.all(files.map(async (path) => [path, sha256(await readFile(join(root, path)))])));
  const snapshotPath = join(root, ".work", "research-snapshot.json");
  await atomicWrite(snapshotPath, {
    schemaVersion: 1,
    research: { artifacts, config, completedAt: new Date().toISOString() },
  });
  return sha256(await readFile(snapshotPath));
}

export async function researchSnapshotSha256(rootPath: string): Promise<string> {
  return sha256(await readFile(join(resolve(rootPath), ".work", "research-snapshot.json")));
}

export async function verifyResearchSnapshot(rootPath: string): Promise<{
  runtime: "LOCAL" | "E2B";
  researchModel: string;
  artifactCount: number;
}> {
  const root = resolve(rootPath);
  const snapshot = snapshotSchema.parse(JSON.parse(await readFile(join(root, ".work", "research-snapshot.json"), "utf8")));
  for (const [path, expected] of Object.entries(snapshot.research.artifacts)) {
    const absolute = resolve(root, path);
    if (absolute === root || !absolute.startsWith(`${root}/`)) throw new Error(`Research artifact path escapes the run: ${path}.`);
    if (sha256(await readFile(absolute)) !== expected) throw new Error(`Research artifact hash differs for ${path}.`);
  }
  return {
    runtime: snapshot.research.config.runtime,
    researchModel: snapshot.research.config.researchModel,
    artifactCount: Object.keys(snapshot.research.artifacts).length,
  };
}
