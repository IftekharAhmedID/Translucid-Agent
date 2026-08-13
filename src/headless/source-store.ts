import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { z } from "zod";

import { deriveArtifactTrust } from "../core/source-trust.ts";

const sourceSchema = z.object({
  ref: z.string().regex(/^S[1-9]\d*$/),
  kind: z.string().min(1),
  provider: z.string().min(1),
  providerRoute: z.string().min(1),
  sourceUrl: z.string().optional(),
  title: z.string().optional(),
  retrievedAt: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().nonnegative(),
  mimeType: z.string().min(1),
  relativePath: z.string().min(1),
  sourceAuthority: z.string().min(1),
  independenceGroup: z.string().min(1),
  canonicalSourceUrl: z.string().min(1),
  provenance: z.record(z.string(), z.unknown()),
}).strict();

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  sources: z.array(sourceSchema),
}).strict();

const readableExcerptLedgerSchema = z.object({
  schemaVersion: z.literal(1),
  excerpts: z.array(z.object({
    ref: z.string().regex(/^X[a-f0-9]{64}$/),
    sourceRef: z.string().regex(/^S[1-9]\d*$/),
    path: z.string().min(1),
    offsetStart: z.number().int().nonnegative(),
    offsetEnd: z.number().int().nonnegative(),
    text: z.string().max(1_000),
  }).strict()),
}).strict();

export type CapturedSourceMetadata = z.infer<typeof sourceSchema>;

export type SourceCaptureInput = {
  kind: string;
  provider: string;
  providerRoute: string;
  sourceUrl?: string;
  title?: string;
  mimeType: string;
  content: unknown;
  provenance: Record<string, unknown>;
  retrievedAt?: string;
};

export type CapturedSource = CapturedSourceMetadata;

export type SourceExcerptRequest = {
  sourceRef: string;
  queries: string[];
  maxCharacters?: number;
};

export type SourceExcerptResult = {
  sourceRef: string;
  excerpts: Array<{ ref: string; path: string; offsetStart: number; offsetEnd: number; text: string }>;
  truncated: boolean;
};

export type BoundedSourceBody = { sourceRef: string; text: string; truncated: boolean };
export type ExactQuoteCheck = { sourceRef: string; path: string; valid: boolean };

type Manifest = z.infer<typeof manifestSchema>;
type FlatValue = { path: string; text: string };

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function extension(mimeType: string): string {
  if (mimeType.includes("json")) return ".json";
  if (mimeType.includes("html")) return ".html";
  if (mimeType.includes("pdf")) return ".pdf";
  if (mimeType.startsWith("text/")) return ".txt";
  return ".bin";
}

function serialize(content: unknown, mimeType: string): Uint8Array {
  if (content instanceof Uint8Array) return content;
  if (typeof content === "string") return Buffer.from(content);
  if (mimeType.includes("json")) return Buffer.from(JSON.stringify(content, null, 2));
  return Buffer.from(typeof content === "undefined" ? "" : String(content));
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
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

function flatten(value: unknown, path = "", output: FlatValue[] = [], depth = 0): FlatValue[] {
  if (depth > 12 || value === null || value === undefined) return output;
  if (["string", "number", "boolean", "bigint"].includes(typeof value)) {
    output.push({ path: path || "$", text: String(value) });
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${path}[${index}]`, output, depth + 1));
    return output;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      flatten(item, path ? `${path}.${key}` : key, output, depth + 1);
    }
  }
  return output;
}

function boundedWindow(text: string, query: string, maximum: number): { text: string; offsetStart: number; offsetEnd: number } | undefined {
  const index = text.toLocaleLowerCase("en-US").indexOf(query.toLocaleLowerCase("en-US"));
  if (index < 0) return undefined;
  const before = Math.floor(Math.max(0, maximum - query.length) / 2);
  const start = Math.max(0, index - before);
  const end = Math.min(text.length, start + maximum);
  return { text: text.slice(start, end), offsetStart: start, offsetEnd: end };
}

function excerptRef(sourceRef: string, path: string, offsetStart: number, offsetEnd: number, text: string): string {
  return `X${createHash("sha256").update([sourceRef, path, offsetStart, offsetEnd, text].join("\0")).digest("hex")}`;
}

export class FileSourceStore {
  private pending: Promise<void> = Promise.resolve();
  private excerptPending: Promise<void> = Promise.resolve();
  private readonly excerptIndex = new Map<string, { ref: string; sourceRef: string; path: string; offsetStart: number; offsetEnd: number; text: string }>();

  private constructor(private readonly root: string, private manifest: Manifest) {}

  static async open(root: string): Promise<FileSourceStore> {
    const path = join(root, "sources", "manifest.json");
    let manifest: Manifest = { schemaVersion: 1, sources: [] };
    try { manifest = manifestSchema.parse(JSON.parse(await readFile(path, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(join(root, "sources", "blobs"), { recursive: true });
      await atomicWrite(path, Buffer.from(JSON.stringify(manifest, null, 2)));
    }
    const store = new FileSourceStore(root, manifest);
    const ledgerPath = join(root, ".work", "finalization", "v4", "excerpts.json");
    try {
      const rawLedger = readableExcerptLedgerSchema.parse(JSON.parse(await readFile(ledgerPath, "utf8")));
      const valid = rawLedger.excerpts.filter((excerpt) => excerpt.text.length > 0 && excerpt.offsetEnd > excerpt.offsetStart);
      for (const excerpt of valid) store.excerptIndex.set(excerpt.ref, excerpt);
      if (valid.length !== rawLedger.excerpts.length) {
        await atomicWrite(ledgerPath, Buffer.from(JSON.stringify({ schemaVersion: 1, excerpts: valid }, null, 2)));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return store;
  }

  private persistExcerpts(): Promise<void> {
    const operation = this.excerptPending.then(async () => {
      const excerpts = [...this.excerptIndex.values()].sort((left, right) => left.ref.localeCompare(right.ref));
      await atomicWrite(join(this.root, ".work", "finalization", "v4", "excerpts.json"), Buffer.from(JSON.stringify({ schemaVersion: 1, excerpts }, null, 2)));
    });
    this.excerptPending = operation.catch(() => undefined);
    return operation;
  }

  capture(input: SourceCaptureInput): Promise<CapturedSource> {
    let result: CapturedSource | undefined;
    const operation = this.pending.then(async () => {
      const bytes = serialize(input.content, input.mimeType);
      const digest = sha256(bytes);
      const trust = deriveArtifactTrust({
        kind: input.kind,
        provider: input.provider,
        sourceUrl: input.sourceUrl,
        content: input.content,
        provenance: { ...input.provenance, providerRoute: input.providerRoute },
      });
      const existing = this.manifest.sources.find((source) => source.sha256 === digest
        && source.kind === input.kind
        && source.providerRoute === input.providerRoute
        && source.canonicalSourceUrl === trust.canonicalSourceUrl);
      if (existing) {
        result = existing;
        return;
      }
      const blobPath = join(this.root, "sources", "blobs", `${digest}${extension(input.mimeType)}`);
      try { await stat(blobPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await atomicWrite(blobPath, bytes);
      }
      const source: CapturedSource = {
        ref: `S${this.manifest.sources.length + 1}`,
        kind: input.kind,
        provider: input.provider,
        providerRoute: input.providerRoute,
        ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
        ...(input.title ? { title: input.title } : {}),
        retrievedAt: input.retrievedAt ?? new Date().toISOString(),
        sha256: digest,
        byteLength: bytes.byteLength,
        mimeType: input.mimeType,
        relativePath: relative(this.root, blobPath),
        sourceAuthority: trust.sourceAuthority,
        independenceGroup: trust.independenceGroup,
        canonicalSourceUrl: trust.canonicalSourceUrl,
        provenance: { ...input.provenance, providerRoute: input.providerRoute },
      };
      this.manifest = { ...this.manifest, sources: [...this.manifest.sources, source] };
      await atomicWrite(join(this.root, "sources", "manifest.json"), Buffer.from(JSON.stringify(this.manifest, null, 2)));
      result = source;
    });
    this.pending = operation.catch(() => undefined);
    return operation.then(() => result!);
  }

  async get(ref: string): Promise<CapturedSource> {
    await this.pending;
    const source = this.manifest.sources.find((item) => item.ref === ref);
    if (!source) throw new Error(`Unknown source reference ${ref}.`);
    return source;
  }

  async list(): Promise<CapturedSourceMetadata[]> {
    await this.pending;
    return this.manifest.sources.map((source) => ({ ...source, provenance: { ...source.provenance } }));
  }

  async excerpts(input: SourceExcerptRequest): Promise<SourceExcerptResult> {
    if (input.queries.length < 1 || input.queries.length > 12) throw new Error("Source excerpts require between one and twelve queries.");
    const maximum = Math.min(Math.max(input.maxCharacters ?? 60_000, 1), 300_000);
    const source = await this.get(input.sourceRef);
    const raw = await readFile(join(this.root, source.relativePath), "utf8");
    let remaining = maximum;
    const excerpts: SourceExcerptResult["excerpts"] = [];
    let matchCount = 0;
    if (source.mimeType.includes("json")) {
      const leaves = flatten(JSON.parse(raw));
      for (const query of input.queries) {
        for (const leaf of leaves) {
          if (!leaf.text || !`${leaf.path}\n${leaf.text}`.toLocaleLowerCase("en-US").includes(query.toLocaleLowerCase("en-US"))) continue;
          matchCount += 1;
          if (remaining <= 0 || excerpts.some((item) => item.path === leaf.path && item.text === leaf.text)) continue;
          const text = leaf.text.slice(0, Math.min(1_000, remaining));
          const offsetStart = raw.indexOf(text);
          const offsetEnd = offsetStart < 0 ? text.length : offsetStart + text.length;
          const item = { ref: excerptRef(source.ref, leaf.path, Math.max(0, offsetStart), offsetEnd, text), sourceRef: source.ref, path: leaf.path, offsetStart: Math.max(0, offsetStart), offsetEnd, text };
          this.excerptIndex.set(item.ref, item);
          excerpts.push({ ref: item.ref, path: item.path, offsetStart: item.offsetStart, offsetEnd: item.offsetEnd, text: item.text });
          remaining -= text.length;
        }
      }
    } else {
      for (const query of input.queries) {
        const window = boundedWindow(raw, query, Math.min(1_000, remaining));
        if (!window) continue;
        matchCount += 1;
        if (remaining <= 0 || excerpts.some((item) => item.text === window.text)) continue;
        const item = { ref: excerptRef(source.ref, "$", window.offsetStart, window.offsetEnd, window.text), sourceRef: source.ref, path: "$", offsetStart: window.offsetStart, offsetEnd: window.offsetEnd, text: window.text };
        this.excerptIndex.set(item.ref, item);
        excerpts.push({ ref: item.ref, path: item.path, offsetStart: item.offsetStart, offsetEnd: item.offsetEnd, text: item.text });
        remaining -= window.text.length;
      }
    }
    await this.persistExcerpts();
    return { sourceRef: source.ref, excerpts, truncated: matchCount > excerpts.length || remaining <= 0 };
  }

  async resolveExcerpt(ref: string): Promise<{ ref: string; sourceRef: string; path: string; offsetStart: number; offsetEnd: number; text: string }> {
    await this.excerptPending;
    const excerpt = this.excerptIndex.get(ref);
    if (!excerpt) throw new Error(`Unknown excerpt reference ${ref}.`);
    return { ...excerpt };
  }

  async verifyExactQuote(input: { sourceRef: string; path: string; exactQuote: string }): Promise<ExactQuoteCheck> {
    const source = await this.get(input.sourceRef);
    const raw = await readFile(join(this.root, source.relativePath), "utf8");
    let valid = false;
    if (source.mimeType.includes("json")) {
      const leaves = flatten(JSON.parse(raw));
      valid = leaves.some((leaf) => leaf.path === input.path && leaf.text.includes(input.exactQuote));
    } else if (input.path === "$") {
      valid = raw.includes(input.exactQuote);
    }
    return { sourceRef: source.ref, path: input.path, valid };
  }

  async readBounded(sourceRef: string, maxCharacters = 80_000): Promise<BoundedSourceBody> {
    const maximum = Math.min(Math.max(maxCharacters, 1), 300_000);
    const source = await this.get(sourceRef);
    const raw = await readFile(join(this.root, source.relativePath), "utf8");
    return { sourceRef, text: raw.slice(0, maximum), truncated: raw.length > maximum };
  }

  async verify(): Promise<{ valid: boolean; invalidSourceRefs: string[] }> {
    await this.pending;
    const invalidSourceRefs: string[] = [];
    for (const source of this.manifest.sources) {
      try {
        const bytes = await readFile(join(this.root, source.relativePath));
        if (bytes.byteLength !== source.byteLength || sha256(bytes) !== source.sha256) invalidSourceRefs.push(source.ref);
      } catch { invalidSourceRefs.push(source.ref); }
    }
    return { valid: invalidSourceRefs.length === 0, invalidSourceRefs };
  }

  async recordRequest(value: Record<string, unknown>): Promise<void> {
    await appendFile(join(this.root, "sources", "requests.jsonl"), `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async requestStats(): Promise<{ providerCalls: number; cacheHits: number }> {
    let raw = "";
    try { raw = await readFile(join(this.root, "sources", "requests.jsonl"), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const rows = raw.split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as { cache?: unknown; status?: unknown }]; }
      catch { return []; }
    });
    return {
      providerCalls: rows.filter((row) => row.cache === "MISS").length,
      cacheHits: rows.filter((row) => row.cache === "HIT").length,
    };
  }
}
