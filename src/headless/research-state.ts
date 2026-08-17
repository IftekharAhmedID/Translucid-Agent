import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import type { FileSourceStore } from "./source-store.ts";

const sourceRefSchema = z.string().regex(/^S[1-9]\d*$/);

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
  claims: z.array(researchClaimSchema).min(1).max(500),
  identityAnchors: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
}).strict();

const researchStateSchema = z.object({
  schemaVersion: z.literal(1),
  updatedAt: z.string().min(1),
  identityAnchors: z.array(z.string().min(1).max(500)).max(100),
  sourceRefs: z.array(sourceRefSchema).max(10_000),
  attemptedRoutes: z.array(z.string().min(1).max(200)).max(1_000),
  claims: z.array(researchClaimSchema).min(1).max(500),
}).strict();

const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  research: z.object({
    artifacts: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    config: z.object({ runtime: z.enum(["LOCAL", "E2B"]), researchModel: z.string().min(1) }).loose(),
    completedAt: z.string().min(1),
  }).strict(),
}).strict();

export type ResearchClaim = z.infer<typeof researchClaimSchema>;
export type ResearchState = z.infer<typeof researchStateSchema>;

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

export class ResearchStateStore {
  private state: ResearchState | undefined;
  private readonly attemptedRoutes = new Set<string>();
  private pending: Promise<void> = Promise.resolve();

  private constructor(private readonly root: string, private readonly sourceStore: FileSourceStore, state?: ResearchState) {
    this.state = state;
    for (const route of state?.attemptedRoutes ?? []) this.attemptedRoutes.add(route);
  }

  static async open(rootPath: string, sourceStore: FileSourceStore): Promise<ResearchStateStore> {
    const root = resolve(rootPath);
    let state: ResearchState | undefined;
    try {
      state = researchStateSchema.parse(JSON.parse(await readFile(join(root, ".work", "research-state.json"), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return new ResearchStateStore(root, sourceStore, state);
  }

  recordRoute(route: string): void {
    if (route.trim()) this.attemptedRoutes.add(route.trim().slice(0, 200));
  }

  async set(input: unknown): Promise<{ ok: true; claimCount: number; sourceRefs: string[] }> {
    const value = researchStateInputSchema.parse(input);
    const sourceRefs = sortedRefs((await this.sourceStore.list()).map(({ ref }) => ref));
    const known = new Set(sourceRefs);
    const referenced = value.claims.flatMap(({ supportingRefs, conflictingRefs }) => [...supportingRefs, ...conflictingRefs]);
    const unknown = sortedRefs(referenced.filter((ref) => !known.has(ref)));
    if (unknown.length) throw new Error(`Research state references unknown source(s): ${unknown.join(", ")}.`);
    const next = researchStateSchema.parse({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      identityAnchors: [...new Set(value.identityAnchors)],
      sourceRefs,
      attemptedRoutes: [...this.attemptedRoutes].sort(),
      claims: value.claims.map((claim) => ({ ...claim, supportingRefs: sortedRefs(claim.supportingRefs), conflictingRefs: sortedRefs(claim.conflictingRefs) })),
    });
    const operation = this.pending.then(async () => {
      await atomicWrite(join(this.root, ".work", "research-state.json"), next);
      this.state = next;
    });
    this.pending = operation.catch(() => undefined);
    await operation;
    return { ok: true, claimCount: next.claims.length, sourceRefs: next.sourceRefs };
  }

  async current(): Promise<ResearchState | undefined> {
    await this.pending;
    return this.state ? structuredClone(this.state) : undefined;
  }

  async hasValidState(): Promise<boolean> {
    return Boolean(await this.current());
  }

  async refresh(): Promise<void> {
    await this.pending;
    if (!this.state) return;
    const sourceRefs = sortedRefs((await this.sourceStore.list()).map(({ ref }) => ref));
    const next = researchStateSchema.parse({
      ...this.state,
      updatedAt: new Date().toISOString(),
      sourceRefs,
      attemptedRoutes: [...this.attemptedRoutes].sort(),
    });
    const operation = this.pending.then(async () => {
      await atomicWrite(join(this.root, ".work", "research-state.json"), next);
      this.state = next;
    });
    this.pending = operation.catch(() => undefined);
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

export async function writeResearchSnapshot(rootPath: string, config: { runtime: "LOCAL" | "E2B"; researchModel: string }, sourceStore: FileSourceStore): Promise<void> {
  const root = resolve(rootPath);
  const state = await readFile(join(root, ".work", "research-state.json"), "utf8");
  researchStateSchema.parse(JSON.parse(state));
  const files = await snapshotFiles(root, sourceStore);
  const artifacts = Object.fromEntries(await Promise.all(files.map(async (path) => [path, sha256(await readFile(join(root, path)))])));
  await atomicWrite(join(root, ".work", "research-snapshot.json"), {
    schemaVersion: 1,
    research: { artifacts, config, completedAt: new Date().toISOString() },
  });
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
