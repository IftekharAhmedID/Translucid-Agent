import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import type { FileSourceStore } from "./source-store.ts";

export const reportToolNames = [
  "report.summary.set",
  "report.finding.upsert",
  "report.finding.remove",
  "report.progress.get",
  "report.finalize",
] as const;

const sourceRefSchema = z.string().regex(/^S[1-9]\d*$/);
const findingStatusSchema = z.union([z.literal(-2), z.literal(-1), z.literal(0), z.literal(1), z.literal(2)]);

export const pdfTextAnchorSchema = z.object({
  kind: z.literal("PDF_TEXT"),
  page: z.number().int().positive(),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  exact: z.string().trim().min(1).max(6_000),
}).strict().refine(({ lineStart, lineEnd }) => lineEnd >= lineStart, {
  path: ["lineEnd"],
  message: "lineEnd must be greater than or equal to lineStart.",
});

export const reportFindingInputSchema = z.object({
  findingId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  section: z.string().trim().min(1).max(200),
  claim: z.string().trim().min(1).max(6_000),
  anchor: pdfTextAnchorSchema,
  evidence: z.string().trim().min(1).max(12_000),
  notes: z.string().max(6_000).optional(),
  status: findingStatusSchema,
  sourceRefs: z.array(sourceRefSchema).max(200),
}).strict();

const reportSourceSchema = z.object({
  sourceRef: sourceRefSchema,
  title: z.string().optional(),
  url: z.string().optional(),
}).strict();

const storedFindingSchema = reportFindingInputSchema.extend({
  order: z.number().int().positive(),
  sources: z.array(reportSourceSchema),
}).strict();

const runSchema = z.object({
  id: z.string().min(1),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  startedAt: z.string().min(1),
  runtime: z.enum(["LOCAL", "E2B"]),
  model: z.string().min(1),
}).strict();

const draftSchema = z.object({
  schemaVersion: z.literal(1),
  run: runSchema,
  state: z.enum(["OPEN", "READY", "PUBLISHED"]),
  revision: z.number().int().nonnegative(),
  summary: z.string().max(50_000),
  findings: z.array(storedFindingSchema),
}).strict();

export const leanReportResultSchema = z.object({
  schemaVersion: z.literal(2),
  run: runSchema.extend({
    status: z.literal("COMPLETED"),
    completedAt: z.string().min(1),
  }).strict(),
  summary: z.string().trim().min(1).max(50_000),
  findings: z.array(storedFindingSchema.omit({ sourceRefs: true })).min(1),
}).strict();

const documentSchema = z.object({
  pages: z.array(z.object({
    page: z.number().int().positive(),
    lines: z.array(z.object({ line: z.number().int().positive(), text: z.string() }).loose()),
  }).loose()),
}).loose();

type Draft = z.infer<typeof draftSchema>;
export type ReportFindingInput = z.infer<typeof reportFindingInputSchema>;
export type LeanReportResult = z.infer<typeof leanReportResultSchema>;
export type ReportProgress = Draft;

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
    private draft: Draft,
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
    let draft: Draft;
    try {
      draft = draftSchema.parse(JSON.parse(await readFile(path, "utf8")));
      if (JSON.stringify(draft.run) !== JSON.stringify(expectedRun)) {
        throw new ReportStoreError("DRAFT_SCOPE_MISMATCH", "The report draft belongs to different immutable run inputs.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      draft = { schemaVersion: 1, run: expectedRun, state: "OPEN", revision: 0, summary: "", findings: [] };
      await atomicWrite(path, draft);
    }
    return new ReportStore(root, options.sourceStore, document, draft);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private assertOpen(): void {
    if (this.draft.state !== "OPEN") throw new ReportStoreError("REPORT_IMMUTABLE", `Report is ${this.draft.state} and cannot be changed.`);
  }

  private mutationResult(): ReportMutationResult {
    return { ok: true, revision: this.draft.revision, findingCount: this.draft.findings.length };
  }

  private async persist(): Promise<void> {
    await atomicWrite(join(this.root, ".work", "report-draft.json"), this.draft);
  }

  setSummary(input: unknown): Promise<ReportMutationResult> {
    return this.enqueue(async () => {
      this.assertOpen();
      const value = parsed(z.object({ summary: z.string().trim().min(1).max(50_000) }).strict(), input);
      this.draft = { ...this.draft, summary: value.summary, revision: this.draft.revision + 1 };
      await this.persist();
      return this.mutationResult();
    });
  }

  upsertFinding(input: unknown): Promise<ReportMutationResult> {
    return this.enqueue(async () => {
      this.assertOpen();
      const value = parsed(reportFindingInputSchema, input);
      const page = this.document.pages.find((item) => item.page === value.anchor.page);
      const selectedLines = page?.lines.filter(({ line }) => line >= value.anchor.lineStart && line <= value.anchor.lineEnd) ?? [];
      const expectedLineCount = value.anchor.lineEnd - value.anchor.lineStart + 1;
      if (selectedLines.length !== expectedLineCount || !normalizeText(selectedLines.map(({ text }) => text).join("\n")).includes(normalizeText(value.anchor.exact))) {
        throw new ReportStoreError("INVALID_ANCHOR", "anchor.exact was not found in the specified résumé page and line range.", "anchor.exact");
      }
      const sources = [];
      for (const sourceRef of [...new Set(value.sourceRefs)]) {
        try {
          const source = await this.sourceStore.get(sourceRef);
          sources.push({ sourceRef, ...(source.title ? { title: source.title } : {}), ...(source.sourceUrl ? { url: source.sourceUrl } : {}) });
        } catch {
          throw new ReportStoreError("UNKNOWN_SOURCE", `Source reference ${sourceRef} does not exist in this run.`, "sourceRefs");
        }
      }
      const existingIndex = this.draft.findings.findIndex(({ findingId }) => findingId === value.findingId);
      const stored = { ...value, sourceRefs: [...new Set(value.sourceRefs)], sources, order: existingIndex >= 0 ? this.draft.findings[existingIndex]!.order : this.draft.findings.length + 1 };
      const findings = [...this.draft.findings];
      if (existingIndex >= 0) findings[existingIndex] = stored;
      else findings.push(stored);
      this.draft = { ...this.draft, findings, revision: this.draft.revision + 1 };
      await this.persist();
      return this.mutationResult();
    });
  }

  removeFinding(input: unknown): Promise<ReportMutationResult> {
    return this.enqueue(async () => {
      this.assertOpen();
      const { findingId } = parsed(z.object({ findingId: reportFindingInputSchema.shape.findingId }).strict(), input);
      const findings = this.draft.findings.filter((finding) => finding.findingId !== findingId);
      if (findings.length === this.draft.findings.length) return this.mutationResult();
      this.draft = { ...this.draft, findings, revision: this.draft.revision + 1 };
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
      if (!this.draft.summary.trim()) throw new ReportStoreError("INCOMPLETE_REPORT", "Set the investigation summary before finalizing.", "summary");
      if (!this.draft.findings.length) throw new ReportStoreError("INCOMPLETE_REPORT", "Register at least one finding before finalizing.", "findings");
      this.draft = { ...this.draft, state: "READY", revision: this.draft.revision + 1 };
      await this.persist();
      return this.mutationResult();
    });
  }

  markPublished(): Promise<ReportMutationResult> {
    return this.enqueue(async () => {
      if (this.draft.state === "OPEN") throw new ReportStoreError("INCOMPLETE_REPORT", "The report must be READY before publication.");
      if (this.draft.state === "PUBLISHED") return this.mutationResult();
      this.draft = { ...this.draft, state: "PUBLISHED", revision: this.draft.revision + 1 };
      await this.persist();
      return this.mutationResult();
    });
  }

  async result(completedAt: string): Promise<LeanReportResult> {
    await this.pending;
    if (this.draft.state === "OPEN") throw new ReportStoreError("INCOMPLETE_REPORT", "The report is not ready for publication.");
    return leanReportResultSchema.parse({
      schemaVersion: 2,
      run: { ...this.draft.run, status: "COMPLETED", completedAt },
      summary: this.draft.summary,
      findings: this.draft.findings.map(({ sourceRefs: _sourceRefs, ...finding }) => finding),
    });
  }
}
