import { appendFile, mkdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname } from "node:path";

export type RunTimelineEvent = {
  kind: string;
  phase?: string;
  name?: string;
  model?: string;
  provider?: string;
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

  summary(): { startedAt: string; completedAt: string; totalElapsedMs: number; eventCount: number } {
    const completed = Date.now();
    return { startedAt: new Date(this.startedAt).toISOString(), completedAt: new Date(completed).toISOString(), totalElapsedMs: Math.max(0, Math.round(performance.now() - this.startedMono)), eventCount: this.events.length };
  }
}
