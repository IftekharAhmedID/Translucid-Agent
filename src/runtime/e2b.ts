import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { ALL_TRAFFIC, Sandbox } from "e2b";

import { waitForHttp } from "./process.ts";
import { openCodeRuntimeEnvironment, type InvestigatorRuntime, type RunHandle, type RunStatus, type RuntimeStartInput } from "./types.ts";

async function workspaceFiles(root: string, path = root): Promise<Array<{ path: string; data: Uint8Array }>> {
  const entries = await readdir(path, { withFileTypes: true });
  const results: Array<{ path: string; data: Uint8Array }> = [];
  for (const entry of entries) {
    const absolute = resolve(path, entry.name);
    if (entry.isDirectory()) results.push(...await workspaceFiles(root, absolute));
    else results.push({ path: `/workspace/case/${relative(root, absolute)}`, data: await readFile(absolute) });
  }
  return results;
}

export class E2BRuntime implements InvestigatorRuntime {
  constructor(private readonly config: { apiKey: string; templateId: string }) {}

  async start(input: RuntimeStartInput): Promise<RunHandle> {
    const gatewayHost = new URL(input.gatewayUrl).hostname;
    const sandbox = await Sandbox.create(this.config.templateId, {
      apiKey: this.config.apiKey,
      timeoutMs: input.timeoutMs,
      secure: true,
      envs: {
        CASE_GATEWAY_URL: input.gatewayUrl,
        CASE_TOKEN: input.caseToken,
        INVESTIGATION_ID: input.investigationId,
        RUN_ID: input.runId,
        OPENCODE_SERVER_PASSWORD: input.openCodePassword,
        TRANSLUCID_RUNTIME_MODE: input.mode ?? "legacy",
        ...(input.allowStaleCaseManifest ? { CASE_ALLOW_STALE_MANIFEST: "true" } : {}),
        ...(input.deadlineAt ? { CASE_DEADLINE_AT: input.deadlineAt } : {}),
        ...openCodeRuntimeEnvironment,
      },
      network: { allowOut: [gatewayHost], denyOut: [ALL_TRAFFIC], allowPublicTraffic: false },
      lifecycle: { onTimeout: "kill" },
    });
    try {
      for (const file of await workspaceFiles(input.caseDirectory)) await sandbox.files.write(file.path, Uint8Array.from(file.data).buffer);
      await sandbox.commands.run("/opt/investigator/runtime/start.sh", { background: true, timeoutMs: input.timeoutMs });
      const openCodeUrl = `https://${sandbox.getHost(4096)}`;
      const trafficAccessToken = sandbox.trafficAccessToken;
      if (!trafficAccessToken) throw new Error("Secure E2B sandbox did not return a traffic-access token.");
      const accessHeaders = {
        authorization: `Basic ${Buffer.from(`opencode:${input.openCodePassword}`).toString("base64")}`,
        "e2b-traffic-access-token": trafficAccessToken,
      };
      const unauthenticatedAccess = await fetch(`${openCodeUrl}/global/health`, { signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
      if (unauthenticatedAccess?.ok) throw new Error("Secure E2B OpenCode endpoint accepted unauthenticated traffic.");
      await waitForHttp(openCodeUrl, accessHeaders);
      const manifestPath = input.allowStaleCaseManifest ? "/workspace/case/runtime-manifest.publisher.json" : "/workspace/case/runtime-manifest.json";
      const manifest = JSON.parse(await sandbox.files.read(manifestPath)) as { manifestHash: string };
      if (!input.expectedManifestHash || manifest.manifestHash !== input.expectedManifestHash) throw new Error("E2B publisher runtime manifest does not equal the pinned local manifest.");
      return { kind: "E2B", id: sandbox.sandboxId, openCodeUrl, accessHeaders, manifestHash: manifest.manifestHash };
    } catch (error) {
      await sandbox.kill().catch(() => undefined);
      throw error;
    }
  }

  async stop(handle: RunHandle): Promise<void> {
    if (handle.kind !== "E2B") throw new Error("Invalid E2B runtime handle.");
    await Sandbox.kill(handle.id, { apiKey: this.config.apiKey }).catch(() => undefined);
  }

  async getStatus(handle: RunHandle): Promise<RunStatus> {
    try { await Sandbox.connect(handle.id, { apiKey: this.config.apiKey }); return "RUNNING"; }
    catch { return "STOPPED"; }
  }

  async getOpenCodeUrl(handle: RunHandle): Promise<string> { return handle.openCodeUrl; }
}
