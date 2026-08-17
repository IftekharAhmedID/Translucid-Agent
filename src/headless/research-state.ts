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

const researchStateSchema = z.union([researchStateV1Schema, researchStateV2Schema]);

const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  research: z.object({
    artifacts: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    config: z.object({ runtime: z.enum(["LOCAL", "E2B"]), researchModel: z.string().min(1), leadSessionId: z.string().min(1).optional() }).loose(),
    completedAt: z.string().min(1),
  }).strict(),
}).strict();

export type ResearchClaim = z.infer<typeof researchClaimSchema>;
export type ResearchState = z.infer<typeof researchStateSchema> & { publicationReady: boolean };

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

export class ResearchStateStore {
  private state: ResearchState | undefined;
  private readonly attemptedRoutes = new Set<string>();
  private pending: Promise<void> = Promise.resolve();
  private pendingFailure: unknown;

  private constructor(private readonly root: string, private readonly sourceStore: FileSourceStore, state?: ResearchState) {
    this.state = state;
    for (const route of state?.attemptedRoutes ?? []) this.attemptedRoutes.add(route);
  }

  static async open(rootPath: string, sourceStore: FileSourceStore): Promise<ResearchStateStore> {
    const root = resolve(rootPath);
    let state: ResearchState | undefined;
    try {
      const parsed = researchStateSchema.parse(JSON.parse(await readFile(join(root, ".work", "research-state.json"), "utf8")));
      state = { ...parsed, publicationReady: parsed.schemaVersion === 2 ? parsed.publicationReady : false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") state = undefined;
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
      this.state = next;
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
      this.state = next;
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
