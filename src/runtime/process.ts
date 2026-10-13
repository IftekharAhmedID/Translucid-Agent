import { spawn } from "node:child_process";

export async function runProcess(command: string, args: string[], options: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };
    timer = options.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs) : undefined;
    let outputBytes = 0;
    const capture = (chunk: Buffer, stream: "stdout" | "stderr") => {
      outputBytes += chunk.length;
      if (options.maxOutputBytes && outputBytes > options.maxOutputBytes) {
        child.kill("SIGKILL"); finish(new Error("Process output exceeded the safety limit.")); return;
      }
      if (stream === "stdout") stdout += String(chunk); else stderr += String(chunk);
    };
    child.stdout?.on("data", (chunk) => capture(chunk, "stdout"));
    child.stderr?.on("data", (chunk) => capture(chunk, "stderr"));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(`${command} exited ${code}: ${stderr.slice(0, 2_000)}`));
    });
  });
}

export async function waitForHttp(url: string, headers: Record<string, string> = {}, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/global/health`, { headers, signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "connection failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`OpenCode did not become healthy: ${lastError}`);
}
