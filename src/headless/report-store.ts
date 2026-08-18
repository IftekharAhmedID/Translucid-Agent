import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import type { FileSourceStore } from "./source-store.ts";
import { discoveredAnchorSchema, knownResearchPredicateIds, pdfTextAnchorSchema as researchPdfTextAnchorSchema, statusToNumeric, type ResearchStateStore } from "./research-state.ts";

export const reportToolNames = [
  "report.summary.set",
  "report.finding.upsert",
  "report.finding.remove",
  "report.progress.get",
  "report.finalize",
] as const;

const sourceRefSchema = z.string().regex(/^S[1-9]\d*$/);
const researchClaimIdSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const findingStatusSchema = z.union([z.literal(-2), z.literal(-1), z.literal(0), z.literal(1), z.literal(2)]);
const evidenceRelationSchema = z.enum(["SUPPORTS", "CONTRADICTS", "CONTEXT"]);

export const pdfTextAnchorSchema = researchPdfTextAnchorSchema;
const reportAnchorSchema = z.discriminatedUnion("kind", [pdfTextAnchorSchema, discoveredAnchorSchema]);

const reportFindingFieldsSchema = z.object({
  findingId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  section: z.string().trim().min(1).max(200),
  claim: z.string().trim().min(1).max(6_000),
  anchor: reportAnchorSchema,
  evidence: z.string().trim().min(1).max(12_000),
  notes: z.string().max(6_000).optional(),
  status: findingStatusSchema,
  sourceRefs: z.array(sourceRefSchema).max(200),
}).strict();

export const reportFindingInputSchema = reportFindingFieldsSchema.extend({
  researchClaimIds: z.array(researchClaimIdSchema).min(1).max(500),
}).strict().superRefine(({ researchClaimIds }, context) => {
  if (new Set(researchClaimIds).size !== researchClaimIds.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["researchClaimIds"], message: "researchClaimIds must be unique." });
});

const reportSourceSchema = z.object({
  sourceRef: sourceRefSchema,
  title: z.string().optional(),
  url: z.string().optional(),
}).strict();

const storedFindingSchema = reportFindingFieldsSchema.extend({
  researchClaimIds: z.array(researchClaimIdSchema).min(1).max(500),
  order: z.number().int().positive(),
  sources: z.array(reportSourceSchema),
}).strict();
const enrichedEvidenceEntrySchema = z.object({
  sourceRef: sourceRefSchema,
  relation: evidenceRelationSchema,
  comment: z.string().trim().min(1).max(6_000),
}).strict();
const enrichedStoredFindingSchema = storedFindingSchema.extend({
  predicate: z.string().trim().min(1).max(6_000),
  conclusion: z.string().trim().min(1).max(6_000),
  rationale: z.string().trim().min(1).max(12_000),
  remainingGap: z.string().trim().max(2_000).nullable(),
  evidenceEntries: z.array(enrichedEvidenceEntrySchema).max(200),
}).strict();
const legacyStoredFindingSchema = storedFindingSchema.omit({ researchClaimIds: true });

const runSchema = z.object({
  id: z.string().min(1),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  startedAt: z.string().min(1),
  runtime: z.enum(["LOCAL", "E2B"]),
  model: z.string().min(1),
}).strict();

const legacyDraftSchema = z.object({
  schemaVersion: z.literal(1),
  run: runSchema,
  state: z.enum(["OPEN", "READY", "PUBLISHED"]),
  revision: z.number().int().nonnegative(),
  summary: z.string().max(50_000),
  findings: z.array(legacyStoredFindingSchema),
}).strict();

const draftSchema = z.object({
  schemaVersion: z.literal(2),
  run: runSchema,
  state: z.enum(["OPEN", "READY", "PUBLISHED"]),
  revision: z.number().int().nonnegative(),
  researchSnapshotSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  summary: z.string().max(50_000),
  summaryResearchClaimIds: z.array(researchClaimIdSchema).max(500),
  findings: z.array(z.union([storedFindingSchema, enrichedStoredFindingSchema])),
}).strict();

const legacyLeanReportResultSchema = z.object({
  schemaVersion: z.literal(2),
  run: runSchema.extend({
    status: z.literal("COMPLETED"),
    completedAt: z.string().min(1),
  }).strict(),
  summary: z.string().trim().min(1).max(50_000),
  findings: z.array(storedFindingSchema.omit({ sourceRefs: true, researchClaimIds: true })).min(1),
}).strict();

const currentLeanReportResultSchema = z.object({
  schemaVersion: z.literal(3),
  run: runSchema.extend({
    status: z.literal("COMPLETED"),
    completedAt: z.string().min(1),
  }).strict(),
  researchSnapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  summary: z.string().trim().min(1).max(50_000),
  summaryResearchClaimIds: z.array(researchClaimIdSchema).min(1).max(500),
  findings: z.array(storedFindingSchema.omit({ sourceRefs: true })).min(1),
}).strict();

const legacyV4LeanReportResultSchema = z.object({
  schemaVersion: z.literal(4),
  run: runSchema.extend({
    status: z.literal("COMPLETED"),
    completedAt: z.string().min(1),
  }).strict(),
  researchSnapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  summary: z.string().trim().min(1).max(50_000),
  summaryResearchClaimIds: z.array(researchClaimIdSchema).max(500),
  findings: z.array(storedFindingSchema.omit({ sourceRefs: true })).min(1),
}).strict();

const v4LeanReportResultSchema = z.object({
  schemaVersion: z.literal(4),
  run: runSchema.extend({
    status: z.literal("COMPLETED"),
    completedAt: z.string().min(1),
  }).strict(),
  researchSnapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  summary: z.string().trim().min(1).max(50_000),
  summaryResearchClaimIds: z.array(researchClaimIdSchema).max(500),
  findings: z.array(enrichedStoredFindingSchema.omit({ sourceRefs: true })).min(1),
}).strict();

export const leanReportResultSchema = z.union([legacyLeanReportResultSchema, currentLeanReportResultSchema, v4LeanReportResultSchema, legacyV4LeanReportResultSchema]);

const documentSchema = z.object({
  pages: z.array(z.object({
    page: z.number().int().positive(),
    lines: z.array(z.object({ line: z.number().int().positive(), text: z.string() }).loose()),
  }).loose()),
}).loose();

type LegacyDraft = z.infer<typeof legacyDraftSchema>;
type Draft = z.infer<typeof draftSchema>;
type AnyDraft = Draft | LegacyDraft;
export type ReportFindingInput = z.infer<typeof reportFindingInputSchema>;
export type LeanReportResult = z.infer<typeof leanReportResultSchema>;
export type EnrichedLeanReportResult = z.infer<typeof v4LeanReportResultSchema>;

export function isEnrichedV4Report(value: LeanReportResult): value is EnrichedLeanReportResult {
  return value.schemaVersion === 4 && value.findings.length > 0 && "predicate" in value.findings[0];
}
export type ReportProgress = AnyDraft;

export type ReportMutationResult = {
  ok: true;
  revision: number;
  findingCount: number;
};

export type ReportToolName = (typeof reportToolNames)[number];

export class ReportStoreError extends Error {
  constructor(readonly code: string, message: string, readonly field?: string) {
    super(message);
    this.name = "ReportStoreError";
  }
}

type OpenOptions = {
  runId: string;
  inputSha256: string;
  startedAt: string;
  runtime: "LOCAL" | "E2B";
  model: string;
  sourceStore: FileSourceStore;
  researchState?: ResearchStateStore;
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

function parsed<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new ReportStoreError("INVALID_INPUT", issue?.message ?? "Invalid report input.", issue?.path.join("."));
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export class ReportStore {
  private pending: Promise<void> = Promise.resolve();
  private eventPending: Promise<void> = Promise.resolve();

  private constructor(
    private readonly root: string,
    private readonly sourceStore: FileSourceStore,
    private readonly document: z.infer<typeof documentSchema>,
    private draft: AnyDraft,
    private readonly researchState?: ResearchStateStore,
    private readonly legacy = false,
  ) {}

  static async open(root: string, options: OpenOptions): Promise<ReportStore> {
    const document = documentSchema.parse(JSON.parse(await readFile(join(root, "input", "document.json"), "utf8")));
    const path = join(root, ".work", "report-draft.json");
    const expectedRun = {
      id: options.runId,
      inputSha256: options.inputSha256,
      startedAt: options.startedAt,
      runtime: options.runtime,
      model: options.model,
    };
    let draft: AnyDraft;
    let legacy = false;
    try {
      const raw = JSON.parse(await readFile(path, "utf8"));
      const current = draftSchema.safeParse(raw);
      if (current.success) draft = current.data;
      else {
        draft = legacyDraftSchema.parse(raw);
        legacy = true;
      }
      if (JSON.stringify(draft.run) !== JSON.stringify(expectedRun)) {
        throw new ReportStoreError("DRAFT_SCOPE_MISMATCH", "The report draft belongs to different immutable run inputs.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      draft = { schemaVersion: 2, run: expectedRun, state: "OPEN", revision: 0, researchSnapshotSha256: null, summary: "", summaryResearchClaimIds: [], findings: [] };
      await atomicWrite(path, draft);
    }
    return new ReportStore(root, options.sourceStore, document, draft, options.researchState, legacy);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private assertOpen(): void {
    if (this.legacy) throw new ReportStoreError("LEGACY_DRAFT_READ_ONLY", "Legacy report drafts are read-only and cannot be republished.");
    if (this.draft.state !== "OPEN") throw new ReportStoreError("REPORT_IMMUTABLE", `Report is ${this.draft.state} and cannot be changed.`);
    if (this.draft.schemaVersion !== 2 || !this.draft.researchSnapshotSha256) throw new ReportStoreError("RESEARCH_SNAPSHOT_REQUIRED", "Bind the frozen research snapshot before changing the report.");
  }

  private currentDraft(): Draft {
    if (this.legacy || this.draft.schemaVersion !== 2) throw new ReportStoreError("LEGACY_DRAFT_READ_ONLY", "Legacy report drafts are read-only and cannot be changed.");
    return this.draft;
  }

  private async claimLedger() {
    const state = await this.researchState?.current();
    if (!state || (state.schemaVersion !== 2 && state.schemaVersion !== 3)) throw new ReportStoreError("RESEARCH_STATE_REQUIRED", "A current v2 or v3 research ledger is required for report mappings.");
    return state;
  }

  private async validateResearchClaimIds(ids: string[], field: string) {
    const state = await this.claimLedger();
    if (new Set(ids).size !== ids.length) throw new ReportStoreError("DUPLICATE_RESEARCH_CLAIM", "Research claim IDs must be unique.", field);
    const known = new Set(knownResearchPredicateIds(state));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) throw new ReportStoreError("UNKNOWN_RESEARCH_CLAIM", `Unknown research claim ID(s): ${unknown.join(", ")}.`, field);
    return state;
  }

  private mutationResult(): ReportMutationResult {
    return { ok: true, revision: this.draft.revision, findingCount: this.draft.findings.length };
  }

  private async persist(): Promise<void> {
    await atomicWrite(join(this.root, ".work", "report-draft.json"), this.draft);
  }

  bindResearchSnapshot(sha256: string): Promise<{ ok: true; researchSnapshotSha256: string }> {
    return this.enqueue(async () => {
      if (this.legacy) throw new ReportStoreError("LEGACY_DRAFT_READ_ONLY", "Legacy report drafts cannot be rebound.");
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw new ReportStoreError("INVALID_SNAPSHOT_DIGEST", "Research snapshot SHA-256 must be 64 lowercase hexadecimal characters.");
      const draft = this.currentDraft();
      if (draft.state !== "OPEN") throw new ReportStoreError("REPORT_IMMUTABLE", `Report is ${draft.state} and cannot be changed.`);
      if (draft.researchSnapshotSha256 && draft.researchSnapshotSha256 !== sha256) throw new ReportStoreError("RESEARCH_SNAPSHOT_MISMATCH", "The report is already bound to a different research snapshot.");
      if (draft.researchSnapshotSha256 === sha256) return { ok: true, researchSnapshotSha256: sha256 };
      this.draft = { ...draft, researchSnapshotSha256: sha256, revision: draft.revision + 1 };
      await this.persist();
      return { ok: true, researchSnapshotSha256: sha256 };
    });
  }

  setSummary(input: unknown): Promise<ReportMutationResult> {
    return this.enqueue(async () => {
      this.assertOpen();
      const draft = this.currentDraft();
      const value = parsed(z.object({ summary: z.string().trim().min(1).max(50_000), researchClaimIds: z.array(researchClaimIdSchema).min(1).max(500) }).strict(), input);
      await this.validateResearchClaimIds(value.researchClaimIds, "researchClaimIds");
      this.draft = { ...draft, summary: value.summary, summaryResearchClaimIds: [...new Set(value.researchClaimIds)], revision: draft.revision + 1 };
      await this.persist();
      return this.mutationResult();
    });
  }

  upsertFinding(input: unknown): Promise<ReportMutationResult> {
    return this.enqueue(async () => {
      this.assertOpen();
      const draft = this.currentDraft();
      const value = parsed(reportFindingInputSchema, input);
      const state = await this.validateResearchClaimIds(value.researchClaimIds, "researchClaimIds");
      if (value.anchor.kind === "PDF_TEXT") {
        const anchor = value.anchor as z.infer<typeof pdfTextAnchorSchema>;
        const page = this.document.pages.find((item) => item.page === anchor.page);
        const selectedLines = page?.lines.filter(({ line }) => line >= anchor.lineStart && line <= anchor.lineEnd) ?? [];
        const expectedLineCount = anchor.lineEnd - anchor.lineStart + 1;
        if (selectedLines.length !== expectedLineCount || !normalizeText(selectedLines.map(({ text }) => text).join("\n")).includes(normalizeText(anchor.exact))) {
          throw new ReportStoreError("INVALID_ANCHOR", "anchor.exact was not found in the specified résumé page and line range.", "anchor.exact");
        }
      }
      const sources = [];
      for (const sourceRef of [...new Set(value.sourceRefs)]) {
        let source;
        try {
          source = await this.sourceStore.get(sourceRef);
        } catch {
          throw new ReportStoreError("UNKNOWN_SOURCE", `Source reference ${sourceRef} does not exist in this run.`, "sourceRefs");
        }
        if (source.kind === "SEARCH_DISCOVERY") throw new ReportStoreError("INELIGIBLE_SOURCE", `Search discovery source ${sourceRef} cannot support a report finding.`, "sourceRefs");
        sources.push({ sourceRef, ...(source.title ? { title: source.title } : {}), ...(source.sourceUrl ? { url: source.sourceUrl } : {}) });
      }
      const linkedRefs = new Set(value.researchClaimIds.flatMap((id) => {
        if (state.schemaVersion === 3) {
          const finding = state.findings.find(({ targetId }) => targetId === id);
          return finding?.evidence.map(({ sourceRef }) => sourceRef) ?? [];
        }
        const claim = state.claims.find(({ id: claimId }) => claimId === id)!;
        return [...claim.supportingRefs, ...claim.conflictingRefs];
      }));
      const unlinked = [...new Set(value.sourceRefs)].filter((sourceRef) => !linkedRefs.has(sourceRef));
      if (unlinked.length) throw new ReportStoreError("UNLINKED_SOURCE", `Finding source reference(s) are not linked to its research claims: ${unlinked.join(", ")}.`, "sourceRefs");
      const existingIndex = draft.findings.findIndex(({ findingId }) => findingId === value.findingId);
      const stored = { ...value, sourceRefs: [...new Set(value.sourceRefs)], researchClaimIds: [...new Set(value.researchClaimIds)], sources, order: existingIndex >= 0 ? draft.findings[existingIndex]!.order : draft.findings.length + 1 };
      const findings = [...draft.findings];
      if (existingIndex >= 0) findings[existingIndex] = stored;
      else findings.push(stored);
      this.draft = { ...draft, findings, revision: draft.revision + 1 };
      await this.persist();
      return this.mutationResult();
    });
  }

  materializeV3(): Promise<ReportMutationResult> {
    return this.enqueue(async () => {
      this.assertOpen();
      const draft = this.currentDraft();
      const state = await this.researchState?.current();
      if (!state || state.schemaVersion !== 3 || state.phase !== "COMMITTED") throw new ReportStoreError("RESEARCH_STATE_REQUIRED", "A committed v3 research state is required for deterministic materialization.");
      if (!state.summary) throw new ReportStoreError("INCOMPLETE_REPORT", "A committed v3 state must contain a summary.", "summary");
      const sourcesByRef = new Map((await this.sourceStore.list()).map((source) => [source.ref, source]));
      const findings = state.targets.map((target, index) => {
        const finding = state.findings.find(({ targetId }) => targetId === target.id);
        if (!finding) throw new ReportStoreError("INCOMPLETE_REPORT", "Target " + target.id + " has no finding.", "findings");
        const evidenceEntries = finding.evidence.map(({ sourceRef, relation, comment }) => ({ sourceRef, relation, comment }));
        const evidence = evidenceEntries.map(({ sourceRef, relation, comment }) => `${relation} — ${comment} [${sourceRef}]`).join("\n") || "No eligible source evidence was captured.";
        if (evidence.length > 12_000) throw new ReportStoreError("EVIDENCE_TOO_LARGE", "Finding " + target.id + " evidence comments exceed the report limit.", "evidence");
        const sourceRefs = [...new Set(finding.evidence.map(({ sourceRef }) => sourceRef))];
        const sources = sourceRefs.map((sourceRef) => {
          const source = sourcesByRef.get(sourceRef);
          if (!source) throw new ReportStoreError("UNKNOWN_SOURCE", "Source reference " + sourceRef + " does not exist in this run.", "sourceRefs");
          if (source.kind === "SEARCH_DISCOVERY") throw new ReportStoreError("INELIGIBLE_SOURCE", "Search discovery source " + sourceRef + " cannot support a report finding.", "sourceRefs");
          return { sourceRef, ...(source.title ? { title: source.title } : {}), ...(source.sourceUrl ? { url: source.sourceUrl } : {}) };
        });
        return {
          findingId: target.id,
          section: target.section,
          claim: target.predicate,
          predicate: target.predicate,
          conclusion: finding.conclusion,
          anchor: target.anchor,
          evidence,
          evidenceEntries,
          rationale: finding.rationale,
          remainingGap: finding.remainingGap,
          notes: [
            target.anchor.kind === "DISCOVERED" ? "Anchor basis: " + target.anchor.basis : "",
            finding.rationale,
            finding.remainingGap ? "Remaining gap: " + finding.remainingGap : "",
          ].filter(Boolean).join(" ").slice(0, 6_000),
          status: statusToNumeric(finding.status),
          sourceRefs,
          researchClaimIds: [target.id],
          order: index + 1,
          sources,
        };
      });
      this.draft = {
        ...draft,
        summary: state.summary.text,
        summaryResearchClaimIds: [...state.summary.targetIds],
        findings,
        state: "READY",
        revision: draft.revision + 1,
      };
      await this.persist();
      return this.mutationResult();
    });
  }

  removeFinding(input: unknown): Promise<ReportMutationResult> {
    return this.enqueue(async () => {
      this.assertOpen();
      const draft = this.currentDraft();
      const { findingId } = parsed(z.object({ findingId: reportFindingInputSchema.shape.findingId }).strict(), input);
      const findings = draft.findings.filter((finding) => finding.findingId !== findingId);
      if (findings.length === draft.findings.length) return this.mutationResult();
      this.draft = { ...draft, findings, revision: draft.revision + 1 };
      await this.persist();
      return this.mutationResult();
    });
  }

  async progress(): Promise<ReportProgress> {
    await this.pending;
    return structuredClone(this.draft);
  }

  recordToolCall(input: { tool: string; sessionId: string; agent: string; callId: string }): Promise<void> {
    const event = {
      schemaVersion: 1,
      tool: input.tool.slice(0, 100),
      sessionId: input.sessionId.slice(0, 200),
      agent: input.agent.slice(0, 100),
      callId: input.callId.slice(0, 200),
      recordedAt: new Date().toISOString(),
    };
    const operation = this.eventPending.then(async () => {
      const path = join(this.root, ".work", "report-events.jsonl");
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    });
    this.eventPending = operation.catch(() => undefined);
    return operation;
  }

  finalize(): Promise<ReportMutationResult> {
    return this.enqueue(async () => {
      this.assertOpen();
      if (this.draft.schemaVersion !== 2 || !this.draft.summary.trim() || !this.draft.summaryResearchClaimIds.length) throw new ReportStoreError("INCOMPLETE_REPORT", "Set the investigation summary and its research claim IDs before finalizing.", "summary");
      if (!this.draft.findings.length) throw new ReportStoreError("INCOMPLETE_REPORT", "Register at least one finding before finalizing.", "findings");
      this.draft = { ...this.draft, state: "READY", revision: this.draft.revision + 1 };
      await this.persist();
      return this.mutationResult();
    });
  }

  markPublished(): Promise<ReportMutationResult> {
    return this.enqueue(async () => {
      if (this.legacy) throw new ReportStoreError("LEGACY_DRAFT_READ_ONLY", "Legacy report drafts cannot be republished.");
      if (this.draft.state === "OPEN") throw new ReportStoreError("INCOMPLETE_REPORT", "The report must be READY before publication.");
      if (this.draft.state === "PUBLISHED") return this.mutationResult();
      this.draft = { ...this.draft, state: "PUBLISHED", revision: this.draft.revision + 1 };
      await this.persist();
      return this.mutationResult();
    });
  }

  async result(completedAt: string): Promise<LeanReportResult> {
    await this.pending;
    if (this.legacy) throw new ReportStoreError("LEGACY_DRAFT_READ_ONLY", "Legacy report drafts are inspectable but cannot be republished.");
    if (this.draft.state === "OPEN" || this.draft.schemaVersion !== 2 || !this.draft.researchSnapshotSha256) throw new ReportStoreError("INCOMPLETE_REPORT", "The report is not ready for publication.");
    const state = await this.researchState?.current();
    const schemaVersion = state?.schemaVersion === 3 ? 4 : 3;
    const payload = {
      schemaVersion,
      run: { ...this.draft.run, status: "COMPLETED" as const, completedAt },
      researchSnapshotSha256: this.draft.researchSnapshotSha256,
      summary: this.draft.summary,
      summaryResearchClaimIds: this.draft.summaryResearchClaimIds,
      findings: this.draft.findings.map(({ sourceRefs: _sourceRefs, ...finding }) => finding),
    };
    return (schemaVersion === 4 ? v4LeanReportResultSchema : currentLeanReportResultSchema).parse(payload);
  }
}
