import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { runProcess, waitForHttp } from "./process.ts";
import { openCodeRuntimeEnvironment, type InvestigatorRuntime, type RunHandle, type RunStatus, type RuntimeStartInput } from "./types.ts";

const imageName = "translucid-investigator:1.18.15";
let buildPromise: Promise<void> | undefined;

async function ensureImage(): Promise<void> {
  buildPromise ??= runProcess("docker", ["build", "--pull", "--tag", imageName, "."], { timeoutMs: 10 * 60_000 }).then(() => undefined);
  return buildPromise;
}

export async function getPinnedLocalManifestHash(): Promise<string> {
  const result = await runProcess(process.execPath, ["--import", "tsx", "scripts/runtime-manifest.ts"], { timeoutMs: 60_000 });
  return (JSON.parse(result.stdout) as { manifestHash: string }).manifestHash;
}

export async function getPinnedResearchManifestHash(): Promise<string> {
  const result = await runProcess(process.execPath, ["--import", "tsx", "scripts/runtime-manifest.ts", "--scope", "research"], { timeoutMs: 60_000 });
  return (JSON.parse(result.stdout) as { manifestHash: string }).manifestHash;
}

function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

export class LocalDockerRuntime implements InvestigatorRuntime {
  async start(input: RuntimeStartInput): Promise<RunHandle> {
    await ensureImage();
    const name = `translucid-case-${input.runId}`;
    const gatewayUrl = input.gatewayUrl.replace("127.0.0.1", "host.docker.internal").replace("localhost", "host.docker.internal");
    await runProcess("docker", [
      "run", "--detach", "--rm", "--name", name, "--label", `com.translucid.run-id=${input.runId}`, "--label", `com.translucid.owner-pid=${process.pid}`,
      "--add-host", "host.docker.internal:host-gateway",
      "--publish", "127.0.0.1::4096",
      "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--pids-limit", "256", "--memory", "2g", "--cpus", "2",
      "--mount", `type=bind,source=${resolve(input.caseDirectory)},target=/workspace/case`,
      "--env", `CASE_GATEWAY_URL=${gatewayUrl}`,
      "--env", `CASE_TOKEN=${input.caseToken}`,
      "--env", `INVESTIGATION_ID=${input.investigationId}`,
      "--env", `RUN_ID=${input.runId}`,
      "--env", `OPENCODE_SERVER_PASSWORD=${input.openCodePassword}`,
      "--env", `TRANSLUCID_RUNTIME_MODE=${input.mode ?? "legacy"}`,
      ...(input.deadlineAt ? ["--env", `CASE_DEADLINE_AT=${input.deadlineAt}`] : []),
      ...Object.entries(openCodeRuntimeEnvironment).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
      imageName,
      "/opt/investigator/runtime/start.sh",
    ], { timeoutMs: 60_000 });
    try {
      const port = (await runProcess("docker", ["port", name, "4096/tcp"])).stdout.trim().split(":").at(-1);
      if (!port) throw new Error("Docker did not publish the OpenCode port.");
      const openCodeUrl = `http://127.0.0.1:${port}`;
      const accessHeaders = { authorization: basicAuth(input.openCodePassword) };
      await waitForHttp(openCodeUrl, accessHeaders);
      const manifest = JSON.parse(await readFile(resolve(input.caseDirectory, "runtime-manifest.json"), "utf8")) as { manifestHash: string };
      if (input.expectedManifestHash && manifest.manifestHash !== input.expectedManifestHash) throw new Error("Local runtime manifest differs from the expected E2B manifest.");
      return { kind: "LOCAL", id: name, openCodeUrl, accessHeaders, manifestHash: manifest.manifestHash };
    } catch (error) {
      await runProcess("docker", ["rm", "--force", name]).catch(() => undefined);
      throw error;
    }
  }

  async stop(handle: RunHandle): Promise<void> {
    if (handle.kind !== "LOCAL" || basename(handle.id) !== handle.id || !handle.id.startsWith("translucid-case-")) throw new Error("Invalid local runtime handle.");
    await runProcess("docker", ["rm", "--force", handle.id], { timeoutMs: 30_000 }).catch((error) => {
      if (!(error instanceof Error) || !error.message.includes("No such container")) throw error;
    });
  }

  async getStatus(handle: RunHandle): Promise<RunStatus> {
    const result = await runProcess("docker", ["inspect", "--format", "{{.State.Status}}", handle.id]).catch(() => undefined);
    if (!result) return "STOPPED";
    return result.stdout.trim() === "running" ? "RUNNING" : result.stdout.trim() === "created" ? "STARTING" : "FAILED";
  }

  async getOpenCodeUrl(handle: RunHandle): Promise<string> { return handle.openCodeUrl; }
}
