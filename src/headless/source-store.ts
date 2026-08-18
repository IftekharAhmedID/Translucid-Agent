import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { z } from "zod";

const sourceSchema = z.object({
  ref: z.string().regex(/^S[1-9]\d*$/),
  kind: z.string().min(1),
  provider: z.string().min(1),
  providerRoute: z.string().min(1),
  sourceUrl: z.string().optional(),
  title: z.string().optional(),
  date: z.string().optional(),
  highlight: z.string().max(4_000).optional(),
  retrievedAt: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().nonnegative(),
  mimeType: z.string().min(1),
  relativePath: z.string().min(1),
  provenance: z.record(z.string(), z.unknown()),
}).passthrough();

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  sources: z.array(sourceSchema),
}).passthrough();

const excerptLedgerSchema = z.object({
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
  date?: string;
  highlight?: string;
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

type Manifest = z.infer<typeof manifestSchema>;
type Excerpt = z.infer<typeof excerptLedgerSchema>["excerpts"][number];
type FlatValue = { path: string; text: string; parentPath: string; order: number };

const excerptStopWords = new Set([
  "about", "after", "again", "also", "and", "are", "been", "before", "being", "between", "but", "can", "for", "from", "had", "has", "have", "into", "its", "more", "not", "of", "on", "or", "our", "that", "the", "their", "then", "there", "these", "they", "this", "those", "through", "was", "were", "with", "would", "you", "your",
]);

function publicSource(source: CapturedSource): CapturedSource {
  return {
    ref: source.ref,
    kind: source.kind,
    provider: source.provider,
    providerRoute: source.providerRoute,
    ...(source.sourceUrl ? { sourceUrl: source.sourceUrl } : {}),
    ...(source.title ? { title: source.title } : {}),
    ...(source.date ? { date: source.date } : {}),
    ...(source.highlight ? { highlight: source.highlight } : {}),
    retrievedAt: source.retrievedAt,
    sha256: source.sha256,
    byteLength: source.byteLength,
    mimeType: source.mimeType,
    relativePath: source.relativePath,
    provenance: { ...source.provenance },
  };
}

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

async function atomicWrite(path: string, bytes: Uint8Array | string): Promise<void> {
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
    const leafPath = path || "$";
    const dot = leafPath.lastIndexOf(".");
    const bracket = leafPath.lastIndexOf("[");
    const parentPath = dot >= 0 ? leafPath.slice(0, dot) || "$" : bracket >= 0 ? leafPath.slice(0, bracket) || "$" : "$";
    output.push({ path: leafPath, text: String(value), parentPath, order: output.length });
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${path}[${index}]`, output, depth + 1));
    return output;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) flatten(item, path ? `${path}.${key}` : key, output, depth + 1);
  }
  return output;
}

function boundedWindow(text: string, query: string, maximum: number): { text: string; offsetStart: number; offsetEnd: number } | undefined {
  const index = text.toLocaleLowerCase("en-US").indexOf(query.toLocaleLowerCase("en-US"));
  if (index < 0) return undefined;
  return boundedRange(text, index, index + query.length, maximum);
}

function boundedRange(text: string, matchStart: number, matchEnd: number, maximum: number): { text: string; offsetStart: number; offsetEnd: number } {
  const before = Math.floor(Math.max(0, maximum - (matchEnd - matchStart)) / 2);
  const start = Math.max(0, matchStart - before);
  const end = Math.min(text.length, start + maximum);
  return { text: text.slice(start, end), offsetStart: start, offsetEnd: end };
}

function excerptTokens(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase("en-US").split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 3 && !excerptStopWords.has(token)))];
}

function tokenPositions(text: string, token: string): number[] {
  const positions: number[] = [];
  const lower = text.toLocaleLowerCase("en-US");
  let offset = 0;
  while (offset < lower.length) {
    const index = lower.indexOf(token, offset);
    if (index < 0) break;
    positions.push(index);
    offset = index + token.length;
  }
  return positions;
}

function leafWindow(leaf: FlatValue & { rawOffset: number }, query: string, maximum: number, exact: boolean, anchors: string[]): { text: string; offsetStart: number; offsetEnd: number } | undefined {
  if (exact) {
    const exactWindow = boundedWindow(leaf.text, query, maximum);
    return exactWindow ?? { text: leaf.text.slice(0, maximum), offsetStart: 0, offsetEnd: Math.min(leaf.text.length, maximum) };
  }
  const positions = anchors.flatMap((anchor) => tokenPositions(leaf.text, anchor).map((start) => ({ start, end: start + anchor.length })));
  if (!positions.length) return undefined;
  const start = Math.min(...positions.map(({ start: value }) => value));
  const end = Math.max(...positions.map(({ end: value }) => value));
  return boundedRange(leaf.text, start, end, maximum);
}

type ExcerptCandidate = {
  leaf: FlatValue & { rawOffset: number };
  exact: boolean;
  coverage: number;
  span: number;
  anchors: string[];
};

function excerptRef(sourceRef: string, path: string, offsetStart: number, offsetEnd: number, text: string): string {
  return `X${createHash("sha256").update([sourceRef, path, offsetStart, offsetEnd, text].join("\0")).digest("hex")}`;
}

export class FileSourceStore {
  private pending: Promise<void> = Promise.resolve();
  private excerptPending: Promise<void> = Promise.resolve();
  private readonly excerptIndex = new Map<string, Excerpt>();

  private constructor(private readonly root: string, private manifest: Manifest) {}

  static async open(root: string): Promise<FileSourceStore> {
    const path = join(root, "sources", "manifest.json");
    let manifest: Manifest = { schemaVersion: 1, sources: [] };
    try {
      manifest = manifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await atomicWrite(path, JSON.stringify(manifest, null, 2));
    }
    const store = new FileSourceStore(root, manifest);
    try {
      const ledger = excerptLedgerSchema.parse(JSON.parse(await readFile(join(root, ".work", "source-excerpts.json"), "utf8")));
      for (const excerpt of ledger.excerpts) store.excerptIndex.set(excerpt.ref, excerpt);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return store;
  }

  private persistExcerpts(): Promise<void> {
    const operation = this.excerptPending.then(async () => {
      const excerpts = [...this.excerptIndex.values()].sort((left, right) => left.ref.localeCompare(right.ref));
      await atomicWrite(join(this.root, ".work", "source-excerpts.json"), JSON.stringify({ schemaVersion: 1, excerpts }, null, 2));
    });
    this.excerptPending = operation.catch(() => undefined);
    return operation;
  }

  capture(input: SourceCaptureInput): Promise<CapturedSource> {
    let result: CapturedSource | undefined;
    const operation = this.pending.then(async () => {
      const bytes = serialize(input.content, input.mimeType);
      const digest = sha256(bytes);
      const existing = this.manifest.sources.find((source) => source.sha256 === digest
        && source.kind === input.kind
        && source.providerRoute === input.providerRoute
        && source.sourceUrl === input.sourceUrl);
      if (existing) {
        result = publicSource(existing);
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
        ...(input.date ? { date: input.date } : {}),
        ...(input.highlight ? { highlight: input.highlight.slice(0, 4_000) } : {}),
        retrievedAt: input.retrievedAt ?? new Date().toISOString(),
        sha256: digest,
        byteLength: bytes.byteLength,
        mimeType: input.mimeType,
        relativePath: relative(this.root, blobPath),
        provenance: { ...input.provenance, providerRoute: input.providerRoute },
      };
      this.manifest = { ...this.manifest, sources: [...this.manifest.sources, source] };
      await atomicWrite(join(this.root, "sources", "manifest.json"), JSON.stringify(this.manifest, null, 2));
      result = publicSource(source);
    });
    this.pending = operation.catch(() => undefined);
    return operation.then(() => result!);
  }

  async get(ref: string): Promise<CapturedSource> {
    await this.pending;
    const source = this.manifest.sources.find((item) => item.ref === ref);
    if (!source) throw new Error(`Unknown source reference ${ref}.`);
    return publicSource(source);
  }

  async list(): Promise<CapturedSourceMetadata[]> {
    await this.pending;
    return this.manifest.sources.map(publicSource);
  }

  async inventory(input: { cursor?: string; limit?: number } = {}): Promise<{
    sources: Array<{
      ref: string;
      url: string | null;
      title: string | null;
      date: string | null;
      route: string;
      highlight: string | null;
      sourceKind: string;
      citationEligible: boolean;
    }>;
    nextCursor: string | null;
  }> {
    await this.pending;
    const limit = Math.min(Math.max(Math.floor(input.limit ?? 100), 1), 100);
    const start = input.cursor ? this.manifest.sources.findIndex((source) => source.ref === input.cursor) + 1 : 0;
    if (input.cursor && start === 0) throw new Error(`Unknown source inventory cursor ${input.cursor}.`);
    const page = this.manifest.sources.slice(start, start + limit);
    const next = start + limit < this.manifest.sources.length ? page.at(-1)?.ref ?? null : null;
    return {
      sources: page.map((source) => ({
        ref: source.ref,
        url: source.sourceUrl ?? null,
        title: source.title ?? null,
        date: source.date ?? null,
        route: source.providerRoute,
        highlight: source.highlight ?? null,
        sourceKind: source.kind,
        citationEligible: source.kind !== "SEARCH_DISCOVERY",
      })),
      nextCursor: next,
    };
  }

  async excerpts(input: SourceExcerptRequest): Promise<SourceExcerptResult> {
    if (input.queries.length < 1 || input.queries.length > 12) throw new Error("Source excerpts require between one and twelve queries.");
    const maximum = Math.min(Math.max(input.maxCharacters ?? 60_000, 1), 300_000);
    const source = await this.get(input.sourceRef);
    const raw = await readFile(join(this.root, source.relativePath), "utf8");
    let remaining = maximum;
    let matchCount = 0;
    const excerpts: SourceExcerptResult["excerpts"] = [];
    const previousCount = this.excerptIndex.size;
    const add = (path: string, text: string, offsetStart: number, offsetEnd: number, budget: number) => {
      if (!text || remaining <= 0 || excerpts.some((item) => item.path === path && item.text === text)) return;
      const bounded = text.slice(0, Math.min(remaining, budget, 1_000));
      const item = { ref: excerptRef(source.ref, path, offsetStart, offsetStart + bounded.length, bounded), sourceRef: source.ref, path, offsetStart, offsetEnd: offsetStart + bounded.length, text: bounded };
      this.excerptIndex.set(item.ref, item);
      excerpts.push({ ref: item.ref, path: item.path, offsetStart: item.offsetStart, offsetEnd: item.offsetEnd, text: item.text });
      remaining -= bounded.length;
    };
    if (source.mimeType.includes("json")) {
      const parsedLeaves = flatten(JSON.parse(raw));
      let rawCursor = 0;
      const leaves = parsedLeaves.map((leaf) => {
        const rawOffset = raw.indexOf(leaf.text, rawCursor);
        if (rawOffset >= 0) rawCursor = rawOffset + leaf.text.length;
        return { ...leaf, rawOffset: rawOffset >= 0 ? rawOffset : Math.max(0, raw.indexOf(leaf.text)) };
      });
      const sourceTokenCounts = new Map<string, number>();
      for (const leaf of leaves) {
        for (const token of excerptTokens(leaf.text)) sourceTokenCounts.set(token, (sourceTokenCounts.get(token) ?? 0) + 1);
      }
      const groups = new Map<string, typeof leaves>();
      for (const leaf of leaves) groups.set(leaf.parentPath, [...(groups.get(leaf.parentPath) ?? []), leaf]);
      const queryBudget = Math.max(1, Math.floor(maximum / input.queries.length));
      for (const query of input.queries) {
        const queryLower = query.toLocaleLowerCase("en-US");
        const exactCandidates: ExcerptCandidate[] = [];
        for (const leaf of leaves) {
          const exactInText = leaf.text.toLocaleLowerCase("en-US").includes(queryLower);
          const exactInPath = leaf.path.toLocaleLowerCase("en-US").includes(queryLower);
          if (!exactInText && !exactInPath) continue;
          const anchors = excerptTokens(query).filter((token) => excerptTokens(leaf.text).includes(token));
          const positions = exactInText ? boundedWindow(leaf.text, query, Math.max(1, queryBudget)) : undefined;
          exactCandidates.push({ leaf, exact: true, coverage: anchors.length, span: positions?.text.length ?? leaf.text.length, anchors });
        }
        let candidates = exactCandidates;
        if (!candidates.length) {
          const present = excerptTokens(query)
            .filter((token) => sourceTokenCounts.has(token))
            .sort((left, right) => (sourceTokenCounts.get(left)! - sourceTokenCounts.get(right)!) || left.localeCompare(right))
            .slice(0, 3);
          if (present.length < 2) continue;
          const anchorSet = new Set(present);
          const fallbackCandidates: ExcerptCandidate[] = [];
          for (const leaf of leaves) {
            const leafTokens = new Set(excerptTokens(leaf.text));
            const coverage = present.filter((token) => leafTokens.has(token)).length;
            if (coverage === present.length) fallbackCandidates.push({ leaf, exact: false, coverage, span: leaf.text.length, anchors: present });
          }
          for (const group of groups.values()) {
            const groupTokens = new Set(group.flatMap((leaf) => excerptTokens(leaf.text)));
            if (!present.every((token) => groupTokens.has(token))) continue;
            for (const leaf of group) {
              const coverage = present.filter((token) => excerptTokens(leaf.text).includes(token)).length;
              if (coverage > 0) fallbackCandidates.push({ leaf, exact: false, coverage, span: group.reduce((total, item) => total + item.text.length, 0), anchors: present });
            }
          }
          candidates = fallbackCandidates;
        }
        candidates.sort((left, right) => Number(right.exact) - Number(left.exact)
          || right.coverage - left.coverage
          || left.span - right.span
          || left.leaf.path.localeCompare(right.leaf.path)
          || left.leaf.order - right.leaf.order);
        const selected: ExcerptCandidate[] = [];
        for (const candidate of candidates) {
          if (selected.some((item) => item.leaf.path === candidate.leaf.path)) continue;
          selected.push(candidate);
          if (selected.length === 3) break;
        }
        if (!selected.length) continue;
        matchCount += selected.length;
        const perWindowBudget = Math.max(1, Math.floor(queryBudget / selected.length));
        for (const candidate of selected) {
          const window = leafWindow(candidate.leaf, query, Math.min(1_000, perWindowBudget), candidate.exact, candidate.anchors);
          if (!window) continue;
          add(candidate.leaf.path, window.text, candidate.leaf.rawOffset + window.offsetStart, candidate.leaf.rawOffset + window.offsetEnd, perWindowBudget);
        }
      }
    } else {
      const queryBudget = Math.max(1, Math.floor(maximum / input.queries.length));
      for (const query of input.queries) {
        const window = boundedWindow(raw, query, Math.min(1_000, queryBudget, remaining));
        if (!window) continue;
        matchCount += 1;
        add("$", window.text, window.offsetStart, window.offsetEnd, queryBudget);
      }
    }
    if (this.excerptIndex.size !== previousCount) await this.persistExcerpts();
    return { sourceRef: source.ref, excerpts, truncated: matchCount > excerpts.length || remaining <= 0 };
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
    await mkdir(join(this.root, "sources"), { recursive: true });
    await appendFile(join(this.root, "sources", "requests.jsonl"), `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async requestStats(): Promise<{ providerCalls: number; cacheHits: number }> {
    let raw = "";
    try { raw = await readFile(join(this.root, "sources", "requests.jsonl"), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const rows = raw.split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as { cache?: unknown }]; }
      catch { return []; }
    });
    return {
      providerCalls: rows.filter((row) => row.cache === "MISS").length,
      cacheHits: rows.filter((row) => row.cache === "HIT").length,
    };
  }

}
