import { performance } from "node:perf_hooks";

import type { ConcreteProviderResult, ProviderCallBackend, ProviderCallInput } from "../providers/backend.ts";
import { redactSecrets } from "../providers/http.ts";
import { providerDeadlineMs } from "../providers/provider-policy.ts";
import { providerRequestFingerprint } from "../providers/request-fingerprint.ts";
import type { MemoryRunBudget } from "./budget.ts";
import type { FileSourceStore } from "./source-store.ts";

type Options = {
  sourceStore: FileSourceStore;
  budget: MemoryRunBudget;
  deadlineAt?: number;
  onProviderActivity?: (event: ProviderActivityEvent) => void;
};

export type ProviderActivityEvent = {
  kind: "provider-start" | "provider-end";
  provider: string;
  providerRoute: string;
  semanticTool: string;
  startedMono: number;
  endedMono?: number;
  elapsedMs?: number;
  batchId?: string;
  batchIndex?: number;
};

export function summarizeProviderIntervals(events: ProviderActivityEvent[]): { requestCount: number; totalElapsedMs: number; maxConcurrent: number; unionElapsedMs: number } {
  const intervals = events.filter((event): event is ProviderActivityEvent & { endedMono: number; elapsedMs: number } => event.kind === "provider-end" && event.endedMono !== undefined && event.elapsedMs !== undefined)
    .map((event) => ({ start: event.endedMono - event.elapsedMs, end: event.endedMono }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const points = intervals.flatMap(({ start, end }) => [{ at: start, delta: 1 }, { at: end, delta: -1 }]).sort((left, right) => left.at - right.at || left.delta - right.delta);
  let active = 0;
  let maxConcurrent = 0;
  for (const point of points) {
    active += point.delta;
    maxConcurrent = Math.max(maxConcurrent, active);
  }
  let unionElapsedMs = 0;
  let unionStart: number | undefined;
  let unionEnd: number | undefined;
  for (const interval of intervals) {
    if (unionStart === undefined) { unionStart = interval.start; unionEnd = interval.end; continue; }
    if (interval.start > unionEnd!) { unionElapsedMs += unionEnd! - unionStart; unionStart = interval.start; unionEnd = interval.end; }
    else unionEnd = Math.max(unionEnd!, interval.end);
  }
  if (unionStart !== undefined) unionElapsedMs += unionEnd! - unionStart;
  return { requestCount: intervals.length, totalElapsedMs: intervals.reduce((sum, interval) => sum + interval.end - interval.start, 0), maxConcurrent, unionElapsedMs: Math.max(0, Math.round(unionElapsedMs)) };
}

function errorStatus(error: unknown): string {
  const status = typeof (error as { status?: unknown })?.status === "number" ? Number((error as { status: number }).status) : undefined;
  if (error instanceof Error && /budget exhausted/i.test(error.message)) return "BUDGET_EXHAUSTED";
  return status === 429 ? "RATE_LIMITED" : "ERROR";
}

export function createFileProviderBackend(options: Options): ProviderCallBackend {
  const cache = new Map<string, Promise<ConcreteProviderResult>>();
  const toolCounts = new Map<string, number>();

  const record = async (input: ProviderCallInput, fingerprint: string, started: number, status: string, cacheStatus: "HIT" | "MISS", result?: ConcreteProviderResult) => {
    await options.sourceStore.recordRequest(redactSecrets({
      runId: input.context.runId,
      agent: input.context.agent,
      sessionId: input.context.sessionId,
      semanticTool: input.semanticTool,
      provider: input.provider,
      providerRoute: input.providerRoute,
      requestFingerprint: fingerprint,
      networkArguments: input.networkArguments,
      status,
      cache: cacheStatus,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      costUsd: cacheStatus === "HIT" ? 0 : result?.costUsd ?? 0,
      costSource: result?.costSource ?? "UNKNOWN",
      sourceRefs: result?.artifactIds ?? [],
    }) as Record<string, unknown>);
  };

  return async (input) => {
    const fingerprint = providerRequestFingerprint(input.providerRoute, input.networkArguments);
    const started = performance.now();
    const cached = cache.get(fingerprint);
    if (cached) {
      try {
        const result = await cached;
        const reused = { ...result, costUsd: 0, artifactIds: [...result.artifactIds], evidenceEligibleArtifactIds: [...result.evidenceEligibleArtifactIds], artifactRefs: result.artifactRefs ? result.artifactRefs.map((ref) => ({ ...ref })) : undefined, reused: true };
        await record(input, fingerprint, started, "OK", "HIT", reused);
        return reused;
      } catch (error) {
        cache.delete(fingerprint);
        throw error;
      }
    }

    const operation = (async (): Promise<ConcreteProviderResult> => {
      const toolCount = toolCounts.get(input.semanticTool) ?? 0;
      if (toolCount + 1 > input.countCeiling) throw new Error(`Budget exhausted for ${input.semanticTool}.`);
      toolCounts.set(input.semanticTool, toolCount + 1);
      await options.budget.recordNetworkCall(input.providerRoute);
      const reserved = input.knownCost?.costUsd ?? 0;
      if (reserved > 0) await options.budget.recordProvider(reserved);
      const signal = options.deadlineAt === undefined
        ? new AbortController().signal
        : AbortSignal.timeout(providerDeadlineMs(input.providerRoute, options.deadlineAt));
      const startedMono = performance.now();
      options.onProviderActivity?.({ kind: "provider-start", provider: input.provider, providerRoute: input.providerRoute, semanticTool: input.semanticTool, startedMono, ...(input.context.batchId ? { batchId: input.context.batchId } : {}), ...(input.context.batchIndex !== undefined ? { batchIndex: input.context.batchIndex } : {}) });
      let result: Awaited<ReturnType<ProviderCallInput["run"]>>;
      try {
        result = await input.run(signal, () => undefined);
      } finally {
        const endedMono = performance.now();
        options.onProviderActivity?.({ kind: "provider-end", provider: input.provider, providerRoute: input.providerRoute, semanticTool: input.semanticTool, startedMono, endedMono, elapsedMs: Math.max(0, Math.round(endedMono - startedMono)), ...(input.context.batchId ? { batchId: input.context.batchId } : {}), ...(input.context.batchIndex !== undefined ? { batchIndex: input.context.batchIndex } : {}) });
      }
      if (result.costUsd > reserved) await options.budget.recordProvider(result.costUsd - reserved);
      const artifactInputs = result.artifacts ?? [{
        kind: "PROVIDER_RESPONSE",
        sourceUrl: result.sourceUrl,
        content: result.data,
        status: result.status,
      }];
      const captured = [] as Array<{ ref: string; kind: string; sourceUrl?: string }>;
      for (const artifact of artifactInputs) {
        const source = await options.sourceStore.capture({
          kind: artifact.kind,
          provider: input.provider,
          providerRoute: input.providerRoute,
          sourceUrl: artifact.sourceUrl,
          ...(artifact.title ? { title: artifact.title } : {}),
          ...(artifact.date ? { date: artifact.date } : {}),
          ...(artifact.highlight ? { highlight: artifact.highlight } : {}),
          mimeType: artifact.mimeType ?? "application/json",
          content: artifact.content,
          provenance: {
            tool: input.semanticTool,
            requestFingerprint: fingerprint,
            networkArguments: redactSecrets(input.networkArguments),
            isSearchSnippet: artifact.kind === "SEARCH_DISCOVERY",
            immutable: true,
            httpStatus: artifact.status ?? result.status ?? 200,
            ...(artifact.provenance ?? {}),
          },
        });
        captured.push({ ref: source.ref, kind: artifact.kind, ...(artifact.sourceUrl ? { sourceUrl: artifact.sourceUrl } : {}) });
      }
      return {
        ...result,
        provider: input.provider,
        providerRoute: input.providerRoute,
        artifactIds: captured.map(({ ref }) => ref),
        evidenceEligibleArtifactIds: captured.filter(({ kind }) => kind !== "SEARCH_DISCOVERY").map(({ ref }) => ref),
        artifactRefs: captured,
        reused: false,
      };
    })();
    cache.set(fingerprint, operation);
    try {
      const result = await operation;
      await record(input, fingerprint, started, "OK", "MISS", result);
      return result;
    } catch (error) {
      cache.delete(fingerprint);
      await record(input, fingerprint, started, errorStatus(error), "MISS");
      throw error;
    }
  };
}
