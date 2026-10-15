import { CommandExitError, Sandbox } from "e2b";
import { RUN_TIMEOUT_MS } from "../headless/deadlines.ts";
import { SubmissionError } from "../web/validation.ts";
import type { DispatchPayload } from "./dispatch.ts";
import { checkDailyCapacity } from "./admission.ts";

export function coordinatorEnvironment(values: Record<string, string>): Record<string, string> {
  const { E2B_TEMPLATE_ID, ...envs } = values;
  if (!E2B_TEMPLATE_ID) throw new Error("Investigator template is not configured.");
  return { ...envs, TRACEDOG_INVESTIGATOR_TEMPLATE_ID: E2B_TEMPLATE_ID };
}

export async function launchInvestigation(payload: DispatchPayload, id: string, config: { templateId: string; envs: Record<string, string> }): Promise<string> {
  const apiKey = config.envs.E2B_API_KEY;
  const envs = coordinatorEnvironment(config.envs);
  const running = await Sandbox.list({ apiKey, query: { metadata: { app: "tracedog-coordinator" }, state: ["running"] }, limit: 5 }).nextItems();
  if (running.length >= 2) throw new SubmissionError("TraceDog is at capacity. Please try again later.", 429);
  await checkDailyCapacity(config.envs, running.length);
  const sandbox = await Sandbox.create(config.templateId, {
    apiKey, timeoutMs: RUN_TIMEOUT_MS + 3 * 60_000, secure: true,
    // E2B sets E2B_TEMPLATE_ID to the coordinator's own image inside the sandbox.
    metadata: { app: "tracedog-coordinator", jobId: id }, envs,
    network: { allowPublicTraffic: true }, lifecycle: { onTimeout: "kill" },
  });
  try {
    await sandbox.files.write("/workspace/job/request.json", JSON.stringify({ id, payload }));
    try {
      await sandbox.commands.run("cd /opt/coordinator && node --import tsx src/serverless/runner.ts prepare", { timeoutMs: 30_000 });
    } catch (error) {
      if (error instanceof CommandExitError) {
        let failure;
        try { failure = JSON.parse(error.stdout.trim()); } catch {}
        if (failure && failure.ok === false && failure.status === 400 && typeof failure.error === "string") throw new SubmissionError(failure.error);
      }
      throw error;
    }
    const command = await sandbox.commands.run("cd /opt/coordinator && node --import tsx src/serverless/runner.ts run", {
      background: true, timeoutMs: RUN_TIMEOUT_MS + 90_000,
      envs: { TRACEDOG_GATEWAY_ORIGIN: `https://${sandbox.getHost(8787)}`, TRACEDOG_COORDINATOR_ID: sandbox.sandboxId },
    });
    await command.disconnect();
    return sandbox.sandboxId;
  } catch (error) {
    await sandbox.kill().catch(() => undefined);
    throw error;
  }
}
