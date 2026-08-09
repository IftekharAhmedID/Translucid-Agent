import { randomBytes } from "node:crypto";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";

import { OpenCodeInvestigationController } from "../agent/controller.ts";
import { getConfig } from "../core/config.ts";
import { getSql } from "../db/client.ts";
import { claimRuns, heartbeatRun, insertAgentEvent, type ClaimedRun } from "../db/investigations.ts";
import { createGatewayServer } from "../gateway/server.ts";
import { stateToolNames } from "../gateway/state-tools.ts";
import { toolNames } from "../providers/contracts.ts";
import { issueCaseToken } from "../providers/security.ts";
import { E2BRuntime } from "../runtime/e2b.ts";
import { getPinnedLocalManifestHash, LocalDockerRuntime } from "../runtime/local-docker.ts";
import type { InvestigatorRuntime, RunHandle } from "../runtime/types.ts";
import { prepareCaseWorkspace } from "./workspace.ts";

const LEASE_MS = 60_000;
const HEARTBEAT_MS = 15_000;

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async use<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try { return await work(); }
    finally { this.active -= 1; this.waiting.shift()?.(); }
  }
}

async function updateTerminalState(run: ClaimedRun, runnerId: string, status: "COMPLETED" | "FAILED" | "CANCELLED" | "TIMED_OUT", error?: Error): Promise<boolean> {
  return getSql().begin(async (transaction) => {
    const [owned] = await transaction<Array<{ id: string }>>`
      UPDATE runs SET status = ${status}, finished_at = now(), lease_owner = NULL,
        lease_expires_at = NULL, error_code = ${error?.name ?? null},
        error_message = ${error?.message.slice(0, 2_000) ?? null}, updated_at = now()
      WHERE id = ${run.id} AND status = 'RUNNING' AND lease_owner = ${runnerId}
      RETURNING id
    `;
    if (!owned) return false;
    if (status === "TIMED_OUT" || status === "FAILED") {
      await transaction`
        INSERT INTO findings (investigation_id, run_id, claim_id, verdict, strength, explanation, supporting_evidence_ids, contradicting_evidence_ids, limitations)
        SELECT ${run.investigationId}, ${run.id}, claim.id, 'UNRESOLVED', 'WEAK',
          'The investigation ended before final adjudication.', '{}'::uuid[], '{}'::uuid[],
          ARRAY[${status === "TIMED_OUT" ? "Investigation deadline reached; captured evidence and open questions were preserved." : "Investigation failed; captured evidence and open questions were preserved."}]
        FROM claims AS claim
        WHERE claim.run_id = ${run.id}
          AND NOT EXISTS (SELECT 1 FROM findings WHERE findings.run_id = ${run.id} AND findings.claim_id = claim.id)
      `;
    }
    await transaction`UPDATE investigations SET status = ${status}, updated_at = now() WHERE id = ${run.investigationId}`;
    return true;
  });
}

async function runOne(run: ClaimedRun, runnerId: string, expectedManifestHash: string): Promise<void> {
  const config = getConfig();
  const controller = new OpenCodeInvestigationController();
  const abort = new AbortController();
  let workspace: string | undefined;
  let attachFile: string | undefined;
  let handle: RunHandle | undefined;
  let runtime: InvestigatorRuntime | undefined;
  let finalizedByThisWorker = false;
  const heartbeat = setInterval(() => { void heartbeatRun(run.id, runnerId, LEASE_MS).catch(() => abort.abort()); }, HEARTBEAT_MS);
  const cancellationMonitor = setInterval(async () => {
    const [row] = await getSql()<Array<{ cancelRequestedAt: Date | null }>>`SELECT cancel_requested_at AS "cancelRequestedAt" FROM investigations WHERE id = ${run.investigationId}`;
    if (row?.cancelRequestedAt || Date.now() >= run.deadlineAt.getTime()) abort.abort();
  }, 1_000);
  try {
    workspace = await prepareCaseWorkspace(run.investigationId, run.id);
    const issued = await issueCaseToken({
      investigationId: run.investigationId,
      runId: run.id,
      allowedTools: [...toolNames, ...stateToolNames, "state.compaction"],
      allowedModels: ["opencode/deepseek-v4-flash", "opencode/mimo-v2.5-free"],
      ttlMs: Math.min(config.investigationTimeoutMs, 30 * 60_000),
    });
    const openCodePassword = randomBytes(24).toString("base64url");
    if (run.runtimeKind === "E2B") {
      if (!process.env.E2B_API_KEY || !process.env.E2B_TEMPLATE_ID || !config.e2bGatewayPublicUrl) throw new Error("E2B runtime configuration is incomplete.");
      runtime = new E2BRuntime({ apiKey: process.env.E2B_API_KEY, templateId: process.env.E2B_TEMPLATE_ID });
    } else runtime = new LocalDockerRuntime();
    handle = await runtime.start({
      investigationId: run.investigationId,
      runId: run.id,
      caseDirectory: workspace,
      gatewayUrl: run.runtimeKind === "E2B" ? config.e2bGatewayPublicUrl! : config.runnerGatewayOrigin,
      caseToken: issued.token,
      openCodePassword,
      expectedManifestHash,
      timeoutMs: Math.max(1_000, run.deadlineAt.getTime() - Date.now()),
    });
    const [owned] = await getSql()<Array<{ id: string }>>`UPDATE runs SET runtime_handle = COALESCE(runtime_handle, '{}'::jsonb) || ${getSql().json({ kind: handle.kind, id: handle.id, openCodeUrl: handle.openCodeUrl, manifestHash: handle.manifestHash })}::jsonb, runtime_manifest_hash = ${handle.manifestHash}, cleanup_status = 'RUNNING', updated_at = now() WHERE id = ${run.id} AND status = 'RUNNING' AND lease_owner = ${runnerId} RETURNING id`;
    if (!owned) throw new Error("Run lease was reclaimed before runtime startup completed.");
    if (handle.kind === "LOCAL") {
      const attachDirectory = resolve(".debug", "attach");
      await mkdir(attachDirectory, { recursive: true, mode: 0o700 });
      attachFile = resolve(attachDirectory, `${run.id}.json`);
      await writeFile(attachFile, JSON.stringify({ openCodeUrl: handle.openCodeUrl, password: openCodePassword }), { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
    await insertAgentEvent({ investigationId: run.investigationId, runId: run.id, phase: "RUNTIME", agent: "runner", eventType: "RUNTIME_READY", status: "RUNNING", payload: { kind: handle.kind, openCodeUrl: handle.openCodeUrl, manifestHash: handle.manifestHash } });
    await controller.run({ investigationId: run.investigationId, runId: run.id, handle, deadlineAt: run.deadlineAt, signal: abort.signal });
    const [caseState] = await getSql()<Array<{ cancelRequestedAt: Date | null }>>`SELECT cancel_requested_at AS "cancelRequestedAt" FROM investigations WHERE id = ${run.investigationId}`;
    const terminalStatus = caseState?.cancelRequestedAt ? "CANCELLED" : Date.now() >= run.deadlineAt.getTime() ? "TIMED_OUT" : "COMPLETED";
    finalizedByThisWorker = await updateTerminalState(run, runnerId, terminalStatus);
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error("Unknown runner error.");
    const [caseState] = await getSql()<Array<{ cancelRequestedAt: Date | null }>>`SELECT cancel_requested_at AS "cancelRequestedAt" FROM investigations WHERE id = ${run.investigationId}`;
    const status = caseState?.cancelRequestedAt ? "CANCELLED" : Date.now() >= run.deadlineAt.getTime() || error.name === "TimeoutError" ? "TIMED_OUT" : "FAILED";
    finalizedByThisWorker = await updateTerminalState(run, runnerId, status, error);
  } finally {
    clearInterval(heartbeat);
    clearInterval(cancellationMonitor);
    if (runtime && handle) await runtime.stop(handle).catch(async (error) => {
      await getSql()`UPDATE runs SET cleanup_status = 'FAILED', error_message = concat_ws(E'\n', error_message, ${error instanceof Error ? error.message.slice(0, 1_000) : "Runtime cleanup failed."}), updated_at = now() WHERE id = ${run.id}`;
    });
    if (finalizedByThisWorker) await getSql()`UPDATE runs SET cleanup_status = CASE WHEN cleanup_status = 'FAILED' THEN 'FAILED' ELSE 'COMPLETED' END, updated_at = now() WHERE id = ${run.id}`;
    if (attachFile) await unlink(attachFile).catch(() => undefined);
    if (workspace?.startsWith(`/var/folders/`) || workspace?.startsWith(`/tmp/`) || workspace?.startsWith(`/private/var/`)) await rm(workspace, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const config = getConfig();
  const origin = new URL(config.runnerGatewayOrigin);
  const gateway = createGatewayServer();
  await new Promise<void>((resolve, reject) => {
    gateway.once("error", reject);
    gateway.listen(Number(origin.port || 3001), origin.hostname, resolve);
  });
  const expectedManifestHash = await getPinnedLocalManifestHash();
  const runnerId = `${hostname()}:${process.pid}`;
  const active = new Set<Promise<void>>();
  const runtimePools = {
    LOCAL: new Semaphore(config.localRuntimeConcurrency),
    E2B: new Semaphore(config.globalE2bConcurrency),
  };
  process.stdout.write(`Runner ${runnerId} ready with concurrency ${config.runnerConcurrency}.\n`);
  while (true) {
    const capacity = config.runnerConcurrency - active.size;
    if (capacity > 0) {
      const claimed = await claimRuns({ leaseOwner: runnerId, limit: capacity, leaseMs: LEASE_MS, timeoutMs: config.investigationTimeoutMs });
      for (const run of claimed) {
        const task = runtimePools[run.runtimeKind].use(() => runOne(run, runnerId, expectedManifestHash)).finally(() => active.delete(task));
        active.add(task);
      }
    }
    if (active.size === config.runnerConcurrency) await Promise.race(active);
    else await sleep(500);
  }
}

await main();
