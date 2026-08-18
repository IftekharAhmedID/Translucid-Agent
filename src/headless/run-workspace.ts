import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";

import { normalizeSubmission, sha256, validatePdfBytes } from "../core/input.ts";
import { extractPdf } from "../../runtime/extract-input.ts";
import { FileSourceStore } from "./source-store.ts";

export type RunWorkspaceInput = {
  outputDirectory: string;
  resumePath?: string;
  submissionPath?: string;
  classification: "SYNTHETIC" | "PUBLIC_PROFESSIONAL";
  runtime: "LOCAL" | "E2B";
  startedAt?: string;
  runId?: string;
};

export type RunWorkspace = {
  runId: string;
  root: string;
  inputSha256: string;
  startedAt: string;
  sourceStore: FileSourceStore;
};

export type ExistingRunWorkspace = RunWorkspace & {
  classification: "SYNTHETIC" | "PUBLIC_PROFESSIONAL";
  runtime: "LOCAL" | "E2B";
};

const existingManifestSchema = z.object({
  runId: z.string().min(1),
  classification: z.enum(["SYNTHETIC", "PUBLIC_PROFESSIONAL"]),
  runtime: z.enum(["LOCAL", "E2B"]),
  startedAt: z.string().min(1),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  inputs: z.array(z.object({
    kind: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    relativePath: z.string().min(1),
  }).loose()).min(1).max(2),
}).loose();

export async function removeRunDiagnostics(root: string): Promise<void> {
  for (const path of [".bun", ".cache", ".config", ".local", ".npm", ".opencode", "output"]) {
    await rm(join(root, path), { recursive: true, force: true });
  }
  for (const path of ["opencode.json", "INSTRUCTIONS.md", "runtime-manifest.json"]) await rm(join(root, path), { force: true });
}

function safeRunId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)) throw new Error("Run ID contains unsupported characters.");
  return value;
}

function inputDigest(parts: Array<{ kind: string; sha256: string }>): string {
  if (parts.length === 1) return parts[0]!.sha256;
  return sha256(parts.map(({ kind, sha256: digest }) => `${kind}:${digest}`).join("\n"));
}

export async function createRunWorkspace(input: RunWorkspaceInput): Promise<RunWorkspace> {
  if (!input.resumePath && !input.submissionPath) throw new Error("At least one input is required.");
  const runId = safeRunId(input.runId ?? randomUUID());
  const outputDirectory = resolve(input.outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  const root = join(outputDirectory, runId);
  try { await mkdir(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Run ${runId} already exists.`);
    throw error;
  }
  const inputDirectory = join(root, "input");
  await mkdir(inputDirectory);
  const startedAt = input.startedAt ?? new Date().toISOString();
  const inputs: Array<Record<string, unknown> & { kind: string; sha256: string }> = [];
  let document: Record<string, unknown> | undefined;

  if (input.resumePath) {
    const sourcePath = resolve(input.resumePath);
    const bytes = await readFile(sourcePath);
    validatePdfBytes(bytes);
    const digest = sha256(bytes);
    const destination = join(inputDirectory, "original.pdf");
    await copyFile(sourcePath, destination);
    const parsed = await extractPdf(destination, inputDirectory, {
      cleanTextName: "document.txt",
      documentName: "document.json",
      agentInputDirectory: "/workspace/case/input",
    });
    document = { sourceType: "PDFJS_STRUCTURED_TEXT", ...parsed };
    inputs.push({ kind: "PDF", sha256: digest, originalName: basename(sourcePath), relativePath: "input/original.pdf" });
  }

  if (input.submissionPath) {
    const sourcePath = resolve(input.submissionPath);
    const raw = await readFile(sourcePath, "utf8");
    const normalized = normalizeSubmission(raw);
    const digest = sha256(raw);
    const originalName = normalized.kind === "JSON" ? "submission.original.json" : "submission.original.txt";
    await writeFile(join(inputDirectory, originalName), raw, { flag: "wx", mode: 0o600 });
    if (!input.resumePath) {
      await writeFile(join(inputDirectory, "document.txt"), normalized.normalized, { flag: "wx", mode: 0o600 });
      const page = { page: 1, lines: normalized.normalized.split(/\r?\n/).map((text, index) => ({ line: index + 1, text })), text: normalized.normalized, sparse: false, links: [] };
      const structured = { schemaVersion: 1, sourceType: `${normalized.kind}_SUBMISSION`, pageCount: 1, pages: [page] };
      await writeFile(join(inputDirectory, "document.json"), JSON.stringify(structured, null, 2), { flag: "wx", mode: 0o600 });
      document = { sourceType: structured.sourceType, cleanTextPath: "/workspace/case/input/document.txt", documentPath: "/workspace/case/input/document.json", pageCount: 1, sparsePageNumbers: [], linkCount: 0 };
    } else {
      const sourceType = `${normalized.kind}_SUBMISSION`;
      const textPath = join(inputDirectory, "document.txt");
      const documentPath = join(inputDirectory, "document.json");
      const [pdfText, parsedDocument] = await Promise.all([
        readFile(textPath, "utf8"),
        readFile(documentPath, "utf8").then((value) => JSON.parse(value) as Record<string, unknown>),
      ]);
      const supplementalSubmission = {
        sourceType,
        lines: normalized.normalized.split(/\r?\n/).map((text, index) => ({ line: index + 1, text })),
        text: normalized.normalized,
      };
      await Promise.all([
        writeFile(textPath, `${pdfText}\n\n--- Supplemental ${normalized.kind} submission ---\n${normalized.normalized}`),
        writeFile(documentPath, JSON.stringify({ ...parsedDocument, supplementalSubmission }, null, 2)),
      ]);
      document = { ...document, sourceType: `PDFJS_STRUCTURED_TEXT_WITH_${sourceType}` };
    }
    inputs.push({ kind: normalized.kind, sha256: digest, originalName: basename(sourcePath), relativePath: `input/${originalName}` });
  }

  const inputSha256 = inputDigest(inputs);
  const manifest = {
    schemaVersion: 1,
    runId,
    classification: input.classification,
    runtime: input.runtime,
    startedAt,
    inputSha256,
    inputs,
    document,
  };
  await writeFile(join(inputDirectory, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
  const sourceStore = await FileSourceStore.open(root);
  return { runId, root, inputSha256, startedAt, sourceStore };
}

export async function openRunWorkspace(rootPath: string): Promise<ExistingRunWorkspace> {
  const root = resolve(rootPath);
  const manifest = existingManifestSchema.parse(JSON.parse(await readFile(join(root, "input", "manifest.json"), "utf8")));
  if (safeRunId(manifest.runId) !== basename(root)) throw new Error("Run directory name does not match its immutable input manifest.");
  const actualInputs = await Promise.all(manifest.inputs.map(async (input) => {
    const absolute = resolve(root, input.relativePath);
    if (!absolute.startsWith(`${root}/`)) throw new Error(`Input path escapes the run: ${input.relativePath}.`);
    const actualSha256 = sha256(await readFile(absolute));
    if (actualSha256 !== input.sha256) throw new Error(`Preserved input hash differs for ${input.relativePath}.`);
    return { kind: input.kind, sha256: actualSha256 };
  }));
  if (inputDigest(actualInputs) !== manifest.inputSha256) throw new Error("Preserved aggregate input hash differs from the immutable input manifest.");
  await readFile(join(root, "input", "document.json"));
  const sourceStore = await FileSourceStore.open(root);
  return {
    runId: manifest.runId,
    root,
    inputSha256: manifest.inputSha256,
    startedAt: manifest.startedAt,
    sourceStore,
    classification: manifest.classification,
    runtime: manifest.runtime,
  };
}

type FailureInput = {
  runId: string;
  code: string;
  message: string;
  phase: string;
  cancelled: boolean;
  diagnostics?: Record<string, unknown>;
};

export async function sealRunFailure(root: string, input: FailureInput): Promise<void> {
  const diagnostics: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(input.diagnostics ?? {})) {
    if (!new Set(["stderr", "stdout", "sessionId", "sandboxId", "exitCode", "timelinePath", "preflightPath", "leadSessionPath", "elapsedMs", "eventCount"]).has(key)) continue;
    if (typeof value === "string") diagnostics[key] = value.slice(0, 8_000);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) diagnostics[key] = value;
  }
  await writeFile(join(root, "failure.json"), JSON.stringify({
    schemaVersion: 1,
    runId: input.runId,
    code: input.code,
    message: input.message.slice(0, 4_000),
    phase: input.phase,
    cancelled: input.cancelled,
    failedAt: new Date().toISOString(),
    diagnostics,
  }, null, 2), { flag: "wx", mode: 0o600 });
}
