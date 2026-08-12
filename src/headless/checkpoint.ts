import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { z } from "zod";

import { MemoryRunBudget, type BudgetCeilings, type BudgetSnapshot } from "./budget.ts";
import { dossierFingerprint, parseEvidenceDossier, type DossierInventory } from "./dossier.ts";

export const RESEARCH_CONTRACT_VERSION = "headless-research-v1";
export const FINALIZER_IMPLEMENTATION_VERSION = "dossier-finalizer-v2";
export const RESULT_SCHEMA_VERSION = "1.1";
export const HANDOFF_MANIFEST_PATH = ".work/finalization/handoff-manifest.json";
export const DOSSIER_PATH = ".work/finalization/evidence-dossier.md";
export const BUDGET_PATH = ".work/finalization/budget.json";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const budgetSnapshotSchema = z.object({
  modelUsd: z.number().nonnegative(),
  providerUsd: z.number().nonnegative(),
  externalNetworkCalls: z.number().int().nonnegative(),
  routeCounts: z.record(z.string(), z.number().int().nonnegative()),
}).strict();

const researchConfigSchema = z.object({
  runtime: z.enum(["LOCAL", "E2B"]),
  providerMode: z.enum(["fixture", "live"]),
  researchModel: z.string().min(1),
  runtimeManifestHash: sha256,
  researchPromptHash: sha256,
  researchSkillBundleHash: sha256,
  contractVersion: z.string().min(1),
  producingGitCommit: z.string().min(1),
}).strict();

const dossierConfigSchema = z.object({
  compilerModel: z.string().min(1),
  resultSchemaVersion: z.string().min(1),
  dossierFormatVersion: z.string().min(1),
  compilerPromptHash: sha256,
  compilerSkillBundleHash: sha256,
  finalizerImplementationVersion: z.string().min(1),
  producingGitCommit: z.string().min(1),
}).strict();

const handoffManifestSchema = z.object({
  schemaVersion: z.literal(1),
  research: z.object({
    fingerprint: sha256,
    artifacts: z.record(z.string(), sha256),
    warnings: z.array(z.string()),
    budget: budgetSnapshotSchema,
    config: researchConfigSchema,
  }).strict(),
  dossier: z.object({
    researchFingerprint: sha256,
    dossierFileHash: sha256,
    semanticInventoryHash: sha256,
    citedSourceHashes: z.record(z.string().regex(/^S[1-9]\d*$/), sha256),
    config: dossierConfigSchema,
  }).strict().optional(),
}).strict();

const sourceManifestSchema = z.object({
  sources: z.array(z.object({
    ref: z.string().regex(/^S[1-9]\d*$/),
    relativePath: z.string().min(1),
  }).loose()),
}).loose();

const runtimeManifestSchema = z.object({
  node: z.string().min(1),
  packages: z.record(z.string(), z.string()),
  files: z.record(z.string(), sha256),
  manifestHash: sha256,
}).strict();
const researchOnlyRuntimeFiles = new Set([
  "runtime/headless-opencode/agents/evidence-compiler.md",
  "runtime/headless-opencode/agents/evidence-auditor.md",
]);

export type ResearchCheckpointConfig = z.infer<typeof researchConfigSchema>;
export type DossierCheckpointConfig = z.infer<typeof dossierConfigSchema>;
export type HandoffManifest = z.infer<typeof handoffManifestSchema>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function researchRuntimeManifestHash(manifest: Pick<z.infer<typeof runtimeManifestSchema>, "node" | "packages" | "files">): string {
  return digest(JSON.stringify({
    node: manifest.node,
    packages: manifest.packages,
    files: Object.fromEntries(Object.entries(manifest.files)
      .filter(([path]) => !researchOnlyRuntimeFiles.has(path))
      .sort()),
  }));
}

async function fileDigest(path: string): Promise<string> {
  return digest(await readFile(path));
}

async function atomicJson(path: string, value: unknown): Promise<void> {
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

function withoutCommit<T extends { producingGitCommit: string }>(config: T): Omit<T, "producingGitCommit"> {
  const copy = { ...config };
  delete (copy as { producingGitCommit?: string }).producingGitCommit;
  return copy;
}

function withoutRuntimeManifestHash<T extends { runtimeManifestHash: string }>(config: T): Omit<T, "runtimeManifestHash"> {
  const copy = { ...config };
  Reflect.deleteProperty(copy, "runtimeManifestHash");
  return copy;
}

function researchFingerprint(input: Omit<HandoffManifest["research"], "fingerprint">): string {
  return digest(canonicalJson({ ...input, config: withoutCommit(input.config) }));
}

function inside(root: string, relativePath: string): string {
  if (isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("..")) throw new Error(`Checkpoint artifact path escapes the run: ${relativePath}.`);
  const absolute = resolve(root, relativePath);
  const prefix = `${resolve(root)}/`;
  if (!absolute.startsWith(prefix)) throw new Error(`Checkpoint artifact path escapes the run: ${relativePath}.`);
  return absolute;
}

async function sourceManifest(root: string): Promise<z.infer<typeof sourceManifestSchema>> {
  return sourceManifestSchema.parse(JSON.parse(await readFile(join(root, "sources", "manifest.json"), "utf8")));
}

async function preservedResearchRuntimeManifestHash(root: string, expectedFullHash: string): Promise<string | undefined> {
  try {
    const manifest = runtimeManifestSchema.parse(JSON.parse(await readFile(join(root, "runtime-manifest.json"), "utf8")));
    if (manifest.manifestHash !== expectedFullHash) return undefined;
    return researchRuntimeManifestHash(manifest);
  } catch {
    return undefined;
  }
}

export async function collectResearchArtifactHashes(root: string): Promise<Record<string, string>> {
  const required = ["input/document.json", "sources/manifest.json"];
  const memoDirectory = join(root, ".work", "memos");
  const memos = (await readdir(memoDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => relative(root, join(memoDirectory, entry.name)));
  if (memos.length === 0) throw new Error("Research checkpoint requires at least one completed memo.");
  const sources = await sourceManifest(root);
  const paths = [...new Set([...required, ...memos, ...sources.sources.map(({ relativePath }) => relativePath)])].sort();
  return Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await fileDigest(inside(root, path))])));
}

export async function writeResearchCheckpoint(root: string, input: {
  warnings: string[];
  budget: BudgetSnapshot;
  config: ResearchCheckpointConfig;
}): Promise<HandoffManifest> {
  const researchWithoutFingerprint = {
    artifacts: await collectResearchArtifactHashes(root),
    warnings: [...input.warnings],
    budget: budgetSnapshotSchema.parse(input.budget),
    config: researchConfigSchema.parse(input.config),
  };
  const manifest: HandoffManifest = {
    schemaVersion: 1,
    research: { fingerprint: researchFingerprint(researchWithoutFingerprint), ...researchWithoutFingerprint },
  };
  await atomicJson(join(root, HANDOFF_MANIFEST_PATH), manifest);
  return manifest;
}

export async function readHandoffManifest(root: string): Promise<HandoffManifest> {
  try {
    return handoffManifestSchema.parse(JSON.parse(await readFile(join(root, HANDOFF_MANIFEST_PATH), "utf8")));
  } catch (error) {
    throw new Error(`Run lacks a valid research checkpoint: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function validateResearchCheckpoint(root: string, current: ResearchCheckpointConfig): Promise<HandoffManifest> {
  const manifest = await readHandoffManifest(root);
  const artifacts = await collectResearchArtifactHashes(root);
  if (canonicalJson(artifacts) !== canonicalJson(manifest.research.artifacts)) throw new Error("Research checkpoint artifact hashes do not match the preserved run.");
  const currentConfig = withoutCommit(current);
  const checkpointConfig = withoutCommit(manifest.research.config);
  let configMatches = canonicalJson(currentConfig) === canonicalJson(checkpointConfig);
  if (!configMatches && current.runtimeManifestHash !== manifest.research.config.runtimeManifestHash) {
    const preservedResearchHash = await preservedResearchRuntimeManifestHash(root, manifest.research.config.runtimeManifestHash);
    const currentWithoutRuntime = withoutRuntimeManifestHash(currentConfig);
    const checkpointWithoutRuntime = withoutRuntimeManifestHash(checkpointConfig);
    configMatches = preservedResearchHash === current.runtimeManifestHash
      && canonicalJson(currentWithoutRuntime) === canonicalJson(checkpointWithoutRuntime);
  }
  if (!configMatches) {
    throw new Error("Research checkpoint runtime, provider, model, contract, prompt, or skill configuration is stale.");
  }
  const expectedFingerprint = researchFingerprint({
    artifacts,
    warnings: manifest.research.warnings,
    budget: manifest.research.budget,
    config: manifest.research.config,
  });
  if (expectedFingerprint !== manifest.research.fingerprint) throw new Error("Research checkpoint fingerprint is invalid.");
  return manifest;
}

async function citedSourceHashes(root: string, inventory: DossierInventory): Promise<Record<string, string>> {
  const sources = await sourceManifest(root);
  const byRef = new Map(sources.sources.map((source) => [source.ref, source]));
  const refs = [...new Set(inventory.evidence.map(({ sourceRef }) => sourceRef))].sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
  return Object.fromEntries(await Promise.all(refs.map(async (ref) => {
    const source = byRef.get(ref);
    if (!source) throw new Error(`Dossier cites unknown source ${ref}.`);
    return [ref, await fileDigest(inside(root, source.relativePath))];
  })));
}

export async function writeDossierCheckpoint(root: string, input: {
  inventory: DossierInventory;
  config: DossierCheckpointConfig;
}): Promise<HandoffManifest> {
  const manifest = await readHandoffManifest(root);
  const updated: HandoffManifest = {
    ...manifest,
    dossier: {
      researchFingerprint: manifest.research.fingerprint,
      dossierFileHash: await fileDigest(join(root, DOSSIER_PATH)),
      semanticInventoryHash: dossierFingerprint(input.inventory),
      citedSourceHashes: await citedSourceHashes(root, input.inventory),
      config: dossierConfigSchema.parse(input.config),
    },
  };
  await atomicJson(join(root, HANDOFF_MANIFEST_PATH), updated);
  return updated;
}

export async function loadValidDossierCheckpoint(root: string, manifest: HandoffManifest, current: DossierCheckpointConfig): Promise<{
  text: string;
  inventory: DossierInventory;
} | undefined> {
  const checkpoint = manifest.dossier;
  if (!checkpoint || checkpoint.researchFingerprint !== manifest.research.fingerprint) return undefined;
  if (canonicalJson(withoutCommit(current)) !== canonicalJson(withoutCommit(checkpoint.config))) return undefined;
  try {
    const text = await readFile(join(root, DOSSIER_PATH), "utf8");
    if (digest(text) !== checkpoint.dossierFileHash) return undefined;
    const allowedSources = new Set(Object.keys(checkpoint.citedSourceHashes));
    const inventory = parseEvidenceDossier(text, allowedSources);
    if (dossierFingerprint(inventory) !== checkpoint.semanticInventoryHash) return undefined;
    if (canonicalJson(await citedSourceHashes(root, inventory)) !== canonicalJson(checkpoint.citedSourceHashes)) return undefined;
    return { text, inventory };
  } catch {
    return undefined;
  }
}

export async function openPersistentRunBudget(root: string, ceilings: BudgetCeilings, fallback?: BudgetSnapshot): Promise<MemoryRunBudget> {
  const path = join(root, BUDGET_PATH);
  let initial = fallback;
  try {
    initial = budgetSnapshotSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Persisted finalization budget is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const snapshot = initial ?? { modelUsd: 0, providerUsd: 0, externalNetworkCalls: 0, routeCounts: {} };
  await atomicJson(path, snapshot);
  return new MemoryRunBudget(ceilings, { initial: snapshot, onChange: (next) => atomicJson(path, next) });
}

export async function archivePriorFailure(root: string, now = new Date()): Promise<string | undefined> {
  const source = join(root, "failure.json");
  const archive = join(root, ".work", "finalization", "failures");
  await mkdir(archive, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const destination = join(archive, `failure-${stamp}-${randomUUID()}.json`);
  try {
    await rename(source, destination);
    return destination;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function hashBundle(root: string, relativePaths: string[], virtualValues: Record<string, string> = {}): Promise<string> {
  const files = Object.fromEntries(await Promise.all([...new Set(relativePaths)].sort().map(async (path) => [path, await fileDigest(inside(root, path))])));
  return digest(canonicalJson({ files, virtualValues }));
}
