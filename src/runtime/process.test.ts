import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { runProcess } from "./process.ts";

test("captures successful and nonzero process results", async () => {
  const success = await runProcess(process.execPath, ["--input-type=module", "-e", "console.log('ready')"]);
  assert.equal(success.stdout.trim(), "ready");
  await assert.rejects(runProcess(process.execPath, ["--input-type=module", "-e", "console.error('failed'); process.exit(3)"]), /exited 3: failed/);
});

test("spawn errors settle a child process without retaining the command timeout", async () => {
  const started = Date.now();
  const child = spawn(process.execPath, [
    "--import", "tsx", "--input-type=module", "-e",
    "import { runProcess } from './src/runtime/process.ts'; try { await runProcess('missing-translucid-command', [], { timeoutMs: 1_500 }); process.exitCode = 1; } catch (error) { if (error?.code !== 'ENOENT') process.exitCode = 2; }",
  ], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: "/definitely-missing-translucid-path" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("close", (code) => resolve({ code, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(Date.now() - started < 1_000, `spawn failure retained the timeout: ${Date.now() - started}ms`);
});
