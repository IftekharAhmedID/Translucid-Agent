import { appendFile, mkdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname } from "node:path";

export type RunTimelineEvent = {
  kind: string;
  phase?: string;
  name?: string;
  model?: string;
  provider?: string;
  semanticTool?: string;
  toolCallId?: string;
  providerStartedAt?: string;
  providerEndedAt?: string;
  providerOutcome?: "OK" | "ERROR";
  providerStartedMono?: number;
  providerEndedMono?: number;
  batchId?: string;
  batchIndex?: number;
  elapsedProviderMs?: number;
  status?: string;
  detail?: string;
};

export class RunTimeline {
  private readonly startedAt = Date.now();
  private readonly startedMono = performance.now();
  private sequence = 0;
  private pending: Promise<void> = Promise.resolve();
  private readonly events: Array<RunTimelineEvent & { seq: number; at: string; elapsedMs: number }> = [];

  constructor(private readonly path: string) {}

  async start(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await this.record({ kind: "run.started" });
  }

  record(event: RunTimelineEvent): Promise<void> {
    const safeEntry = {
      ...event,
      ...(event.detail ? { detail: event.detail.slice(0, 500) } : {}),
      seq: ++this.sequence,
      at: new Date().toISOString(),
      elapsedMs: Math.max(0, Math.round(performance.now() - this.startedMono)),
    };
    this.events.push(safeEntry);
    const operation = this.pending.then(() => appendFile(this.path, `${JSON.stringify(safeEntry)}\n`, { encoding: "utf8", mode: 0o600 }));
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  async flush(): Promise<void> {
    await this.pending;
  }

  publicationOrder(): string[] {
    return this.events.filter(({ kind }) => kind.startsWith("publication.")).map(({ kind }) => kind);
  }

  timingSummary(input: { modelElapsedMs: number; providerElapsedMs: number }): {
    endToEndWallMs: number;
    researchElapsedMs: number | null;
    freezePublicationElapsedMs: number | null;
    publicationElapsedMs: number | null;
    modelElapsedMs: number;
    providerElapsedMs: number;
  } {
    const elapsed = (kind: string): number | null => {
      for (let index = this.events.length - 1; index >= 0; index -= 1) if (this.events[index]?.kind === kind) return this.events[index]!.elapsedMs;
      return null;
    };
    const endToEndWallMs = this.events.at(-1)?.elapsedMs ?? Math.max(0, Math.round(performance.now() - this.startedMono));
    const frozen = elapsed("research.frozen");
    const publicationStarted = elapsed("publication.started");
    const resultWritten = elapsed("publication.result.written");
    return {
      endToEndWallMs,
      researchElapsedMs: frozen,
      freezePublicationElapsedMs: frozen === null || resultWritten === null ? null : Math.max(0, resultWritten - frozen),
      publicationElapsedMs: publicationStarted === null || resultWritten === null ? null : Math.max(0, resultWritten - publicationStarted),
      modelElapsedMs: Math.max(0, Math.round(input.modelElapsedMs)),
      providerElapsedMs: Math.max(0, Math.round(input.providerElapsedMs)),
    };
  }

  summary(): { startedAt: string; completedAt: string; totalElapsedMs: number; eventCount: number } {
    const completed = Date.now();
    return { startedAt: new Date(this.startedAt).toISOString(), completedAt: new Date(completed).toISOString(), totalElapsedMs: Math.max(0, Math.round(performance.now() - this.startedMono)), eventCount: this.events.length };
  }
}
