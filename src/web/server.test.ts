import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request } from "node:http";

test("web API rejects cross-origin, personal email, unknown codes and private routes", async () => {
  const root = mkdtempSync(join(tmpdir(), "tracedog-http-"));
  const port = 18987;
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", "src/web/server.ts"], {
    env: { ...process.env, PORT: String(port), TRACEDOG_ORIGIN: origin, TRACEDOG_DATA_DIR: root, TRACEDOG_ACCEPT_SUBMISSIONS: "true", TRACEDOG_DURABLE_STORAGE: "true", E2B_API_KEY: "test", E2B_TEMPLATE_ID: "test", TRACEDOG_MODEL: "deepseek/deepseek-v4.1-flash", RESEARCH_OPENCODE_PROVIDER: "OPENROUTER", OPENROUTER_API_KEY: "test", OPENCODE_API_KEY: "", RESEND_API_KEY: "test", RESEND_FROM: "test@example.org" }, stdio: "ignore",
  });
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await fetch(origin + "/health").then((r) => r.ok).catch(() => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const post = (path: string, value: unknown, requestOrigin = origin) => fetch(origin + path, { method: "POST", headers: { origin: requestOrigin, "content-type": "application/json" }, body: JSON.stringify(value) });
    assert.equal((await post("/api/submissions", {}, "https://evil.example")).status, 403);
    assert.equal((await post("/api/submissions", { consent: true, email: "a@gmail.com", kind: "text", text: "x".repeat(25) })).status, 400);
    assert.equal((await post("/api/verify", { submissionId: "unknown", code: "123456" })).status, 400);
    assert.equal((await fetch(origin + "/gateway/internal/tools/execute", { method: "POST" })).status, 404);
    assert.equal((await fetch(origin + "/.env")).status, 404);
    assert.equal((await fetch(origin + "/api/results")).status, 403);
    assert.equal((await post("/api/verify", { padding: "x".repeat(2000) })).status, 413);
    const slow = request(origin + "/api/submissions", { method: "POST", headers: { origin, "content-type": "application/json" } });
    slow.on("error", () => undefined);
    slow.write('{"email":');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await post("/api/submissions", {})).status, 429, "admission must happen before buffering a slow upload");
    slow.destroy();
  } finally {
    child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
