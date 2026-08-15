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

export async function persistResearchMemo(rootPath: string, input: unknown): Promise<{ ok: true }> {
  const parsed = memoPayloadSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid research memo payload: ${parsed.error.issues[0]?.message ?? "validation failed"}`);
  const root = resolve(rootPath);
  const value = parsed.data;
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
  });
  return { ok: true };
}

export async function writeResearchSnapshot(rootPath: string, config: { runtime: "LOCAL" | "E2B"; researchModel: string }): Promise<void> {
  const root = resolve(rootPath);
  const memoDirectory = join(root, ".work", "memos");
  const memoFiles = (await readdir(memoDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".sources.json")))
    .map((entry) => join(memoDirectory, entry.name));
  if (!memoFiles.some((path) => path.endsWith(".md"))) throw new Error("Research snapshot requires at least one completed memo.");
  const files = [join(root, "input", "manifest.json"), join(root, "input", "document.json"), join(root, "sources", "manifest.json"), ...memoFiles].sort();
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
