import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const researchSchema = z.object({
  artifacts: z.record(z.string(), sha256Schema),
  config: z.object({
    runtime: z.enum(["LOCAL", "E2B"]),
    researchModel: z.string().min(1),
  }).loose(),
}).loose();
const snapshotSchema = z.object({ schemaVersion: z.literal(1), research: researchSchema }).loose();
const specialistRoleSchema = z.enum(["professional-researcher", "github-researcher", "web-records-researcher", "social-researcher"]);
const ledgerRoleSchema = z.enum(["lead-researcher", "professional-researcher", "github-researcher", "web-records-researcher", "social-researcher"]);
const ledgerEntrySchema = z.object({
  sourceRef: z.string().regex(/^S[1-9]\d*$/),
  disposition: z.enum(["EVIDENCE", "LEAD", "CONTEXT", "LOW_VALUE"]),
  relevance: z.string().trim().min(1).max(2_000),
  sourceFamily: z.string().trim().min(1).max(500),
  claimLane: z.string().trim().min(1).max(500),
  date: z.string().trim().max(100).optional(),
  followUp: z.string().trim().max(2_000).optional(),
  stopReason: z.string().trim().max(2_000).optional(),
}).strict();
const ledgerPayloadSchema = z.object({
  role: ledgerRoleSchema,
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
  encounteredSourceRefs: z.array(z.string().regex(/^S[1-9]\d*$/)).max(10_000),
  entries: z.array(ledgerEntrySchema).max(1_000),
}).strict();
const ledgerFileSchema = z.object({
  schemaVersion: z.literal(1),
  role: ledgerRoleSchema,
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
  encounteredSourceRefs: z.array(z.string().regex(/^S[1-9]\d*$/)).max(10_000),
  entries: z.array(ledgerEntrySchema).max(1_000),
}).strict();
const notebookPayloadSchema = z.object({ markdown: z.string(), recoverySummary: z.string() }).strict();
const memoPayloadSchema = z.object({
  role: specialistRoleSchema,
  wave: z.enum(["INITIAL", "TARGETED"]),
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
  memo: z.string().min(1).max(500_000),
  encounteredSourceRefs: z.array(z.string().regex(/^S[1-9]\d*$/)).max(1_000),
  citedSourceRefs: z.array(z.string().regex(/^S[1-9]\d*$/)).max(1_000),
}).strict().refine(({ encounteredSourceRefs, citedSourceRefs }) => citedSourceRefs.every((ref) => encounteredSourceRefs.includes(ref)), {
  path: ["citedSourceRefs"],
  message: "Cited sources must have been encountered by the specialist session.",
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function atomicBytes(path: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await atomicBytes(path, `${JSON.stringify(value, null, 2)}\n`);
}

const NOTEBOOK_MAX_BYTES = 100 * 1024;
const RECOVERY_MAX_BYTES = 16 * 1024;
const RECOVERY_HEADINGS = [
  "Active claim lanes",
  "Strongest source refs",
  "Contradictions",
  "Unresolved material facets",
  "Current search leads",
  "Next actions",
  "Stop decisions",
];

function safeArtifactName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
}

function sortedRefs(refs: Iterable<string>): string[] {
  return [...new Set(refs)].sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function filesUnder(root: string, directory: string): Promise<string[]> {
  const absolute = join(root, directory);
  let entries;
  try { entries = await readdir(absolute, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, relativePath));
    else if (entry.isFile()) files.push(join(root, relativePath));
  }
  return files;
}

export async function persistResearchMemo(rootPath: string, input: unknown): Promise<{ ok: true }> {
  const parsed = memoPayloadSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid research memo payload: ${parsed.error.issues[0]?.message ?? "validation failed"}`);
  const root = resolve(rootPath);
  const value = parsed.data;
  const ledgerRelativePath = join(".work", "evidence-ledgers", `${safeArtifactName(value.role)}-${safeArtifactName(value.sessionId)}.json`);
  const ledgerPath = join(root, ledgerRelativePath);
  const ledger = ledgerFileSchema.parse(JSON.parse(await readFile(ledgerPath, "utf8")));
  if (ledger.role !== value.role || ledger.sessionId !== value.sessionId) throw new Error("Research memo ledger ownership does not match the completed specialist session.");
  if (value.encounteredSourceRefs.some((ref) => !ledger.encounteredSourceRefs.includes(ref))) throw new Error("Research memo references a source absent from the accepted session ledger.");
  const base = `${value.role}-${value.sessionId}`;
  const encounteredSourceRefs = [...new Set(value.encounteredSourceRefs)].sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
  const citedSourceRefs = [...new Set(value.citedSourceRefs)].sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
  await atomicBytes(join(root, ".work", "memos", `${base}.md`), value.memo);
  await atomicWrite(join(root, ".work", "memos", `${base}.sources.json`), {
    schemaVersion: 1,
    role: value.role,
    wave: value.wave,
    sessionId: value.sessionId,
    memoSha256: sha256(Buffer.from(value.memo)),
    encounteredSourceRefs,
    citedSourceRefs,
    ledgerPath: ledgerRelativePath,
    ledgerSha256: sha256(await readFile(ledgerPath)),
    ledgerEntryCount: ledger.entries.length,
  });
  return { ok: true };
}

export async function persistResearchNotebook(rootPath: string, input: unknown): Promise<{ ok: true; markdownSha256: string; markdownByteLength: number; recoverySha256: string; recoveryByteLength: number }> {
  const parsed = notebookPayloadSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid research notebook payload: ${parsed.error.issues[0]?.message ?? "validation failed"}`);
  const { markdown, recoverySummary } = parsed.data;
  const markdownByteLength = Buffer.byteLength(markdown, "utf8");
  const recoveryByteLength = Buffer.byteLength(recoverySummary, "utf8");
  if (markdownByteLength > NOTEBOOK_MAX_BYTES) throw new Error("Investigation notebook exceeds the 100 KiB limit.");
  if (recoveryByteLength > RECOVERY_MAX_BYTES) throw new Error("Investigation recovery summary exceeds the 16 KiB limit.");
  let cursor = -1;
  for (const heading of RECOVERY_HEADINGS) {
    const index = recoverySummary.indexOf(`## ${heading}`);
    if (index <= cursor) throw new Error(`Investigation recovery summary requires ordered headings: ${heading}.`);
    cursor = index;
  }
  const root = resolve(rootPath);
  await atomicBytes(join(root, ".work", "investigation.md"), markdown);
  await atomicBytes(join(root, ".work", "investigation-recovery.md"), recoverySummary);
  return {
    ok: true,
    markdownSha256: sha256(Buffer.from(markdown)),
    markdownByteLength,
    recoverySha256: sha256(Buffer.from(recoverySummary)),
    recoveryByteLength,
  };
}

export async function persistResearchLedger(rootPath: string, input: unknown): Promise<{ ok: true; entryCount: number; sha256: string; path: string }> {
  const parsed = ledgerPayloadSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid evidence ledger payload: ${parsed.error.issues[0]?.message ?? "validation failed"}`);
  const value = parsed.data;
  const encounteredSourceRefs = sortedRefs(value.encounteredSourceRefs);
  if (value.entries.some(({ sourceRef }) => !encounteredSourceRefs.includes(sourceRef))) throw new Error("Evidence ledger contains a source that the session has not encountered.");
  const root = resolve(rootPath);
  const relativePath = join(".work", "evidence-ledgers", `${safeArtifactName(value.role)}-${safeArtifactName(value.sessionId)}.json`);
  const path = join(root, relativePath);
  let existing: z.infer<typeof ledgerFileSchema> = { schemaVersion: 1, role: value.role, sessionId: value.sessionId, encounteredSourceRefs: [], entries: [] };
  if (await exists(path)) existing = ledgerFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (existing.role !== value.role || existing.sessionId !== value.sessionId) throw new Error("Evidence ledger ownership does not match the requested session.");
  const entries = new Map(existing.entries.map((entry) => [entry.sourceRef, entry]));
  for (const entry of value.entries) entries.set(entry.sourceRef, entry);
  const next = {
    schemaVersion: 1 as const,
    role: value.role,
    sessionId: value.sessionId,
    encounteredSourceRefs: sortedRefs([...existing.encounteredSourceRefs, ...encounteredSourceRefs]),
    entries: [...entries.values()].sort((left, right) => Number(left.sourceRef.slice(1)) - Number(right.sourceRef.slice(1))),
  };
  const bytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
  await atomicBytes(path, bytes);
  return { ok: true, entryCount: next.entries.length, sha256: sha256(bytes), path: relativePath };
}

export async function ensureResearchNotebook(rootPath: string): Promise<void> {
  const root = resolve(rootPath);
  if (await exists(join(root, ".work", "investigation.md")) && await exists(join(root, ".work", "investigation-recovery.md"))) return;
  await persistResearchNotebook(root, {
    markdown: "# Investigation\n\nNo durable notebook entries were written before the research handoff.",
    recoverySummary: RECOVERY_HEADINGS.map((heading) => `## ${heading}\nnone`).join("\n\n"),
  });
}

export async function writeResearchSnapshot(rootPath: string, config: { runtime: "LOCAL" | "E2B"; researchModel: string }): Promise<void> {
  const root = resolve(rootPath);
  await ensureResearchNotebook(root);
  const memoDirectory = join(root, ".work", "memos");
  const memoFiles = (await readdir(memoDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".sources.json")))
    .map((entry) => join(memoDirectory, entry.name));
  if (!memoFiles.some((path) => path.endsWith(".md"))) throw new Error("Research snapshot requires at least one completed memo.");
  const optional = [
    join(root, "sources", "requests.jsonl"),
    join(root, ".work", "source-excerpts.json"),
  ];
  const files = [
    join(root, "input", "manifest.json"),
    join(root, "input", "document.json"),
    join(root, "sources", "manifest.json"),
    join(root, ".work", "investigation.md"),
    join(root, ".work", "investigation-recovery.md"),
    ...memoFiles,
    ...(await filesUnder(root, "sources/blobs")),
    ...(await filesUnder(root, ".work/evidence-ledgers")),
    ...(await Promise.all(optional.map(async (path) => await exists(path) ? path : undefined))).filter((path): path is string => Boolean(path)),
  ].sort();
  const artifacts = Object.fromEntries(await Promise.all(files.map(async (path) => [relative(root, path), sha256(await readFile(path))])));
  await atomicWrite(join(root, ".work", "research-snapshot.json"), {
    schemaVersion: 1,
    research: { artifacts, config, completedAt: new Date().toISOString() },
  });
}

export async function verifyResearchSnapshot(rootPath: string): Promise<{
  runtime: "LOCAL" | "E2B";
  researchModel: string;
  artifactCount: number;
  source: "RESEARCH_SNAPSHOT" | "HISTORICAL_HANDOFF";
}> {
  const root = resolve(rootPath);
  const currentPath = join(root, ".work", "research-snapshot.json");
  let source: "RESEARCH_SNAPSHOT" | "HISTORICAL_HANDOFF" = "RESEARCH_SNAPSHOT";
  let raw: string;
  try {
    raw = await readFile(currentPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    source = "HISTORICAL_HANDOFF";
    raw = await readFile(join(root, ".work", "finalization", "handoff-manifest.json"), "utf8");
  }
  const snapshot = snapshotSchema.parse(JSON.parse(raw));
  for (const [relativePath, expected] of Object.entries(snapshot.research.artifacts)) {
    const path = resolve(root, relativePath);
    if (path === root || !path.startsWith(`${root}/`)) throw new Error(`Research artifact path escapes the run: ${relativePath}.`);
    if (sha256(await readFile(path)) !== expected) throw new Error(`Research artifact hash differs for ${relativePath}.`);
  }
  return {
    runtime: snapshot.research.config.runtime,
    researchModel: snapshot.research.config.researchModel,
    artifactCount: Object.keys(snapshot.research.artifacts).length,
    source,
  };
}
