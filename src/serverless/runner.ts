import { createServer, request as httpRequest } from "node:http";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Sandbox } from "e2b";
import { prepareJob, readPublishedText, retryEmail, type PreparedJob } from "./job.ts";
import { SubmissionError } from "../web/validation.ts";
import { runProcess } from "../runtime/process.ts";
import { RUN_TIMEOUT_MS } from "../headless/deadlines.ts";

const root = "/workspace/job";
const mode = process.argv[2];
if (mode === "prepare") {
  try {
    const request = JSON.parse(await readFile(join(root, "request.json"), "utf8"));
    const job = await prepareJob(root, request.id, request.payload);
    await rm(join(root, "request.json"), { force: true });
    console.log(JSON.stringify({ ok: true, submissionId: job.id }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, status: error instanceof SubmissionError ? error.status : 500, error: error instanceof SubmissionError ? error.message : "Submission could not be prepared." }));
    process.exitCode = 1;
  }
} else if (mode === "run") {
  const job = JSON.parse(await readFile(join(root, "job.json"), "utf8")) as PreparedJob;
  const paths = new Set(["/gateway/internal/tools/execute", "/gateway/internal/llm/v1/chat/completions", "/gateway/internal/llm/v1/responses"]);
  const proxy = createServer((request, response) => {
    const path = request.url ?? "/";
    if (request.method !== "POST" || !paths.has(path) || !request.headers.authorization) { response.writeHead(404); response.end(); return; }
    const forward = httpRequest({ hostname: "127.0.0.1", port: 3001, path: path.slice(8), method: "POST", headers: { ...request.headers, host: "127.0.0.1" }, timeout: 360_000 }, upstream => {
      response.writeHead(upstream.statusCode ?? 502, { "content-type": upstream.headers["content-type"] ?? "application/json", "cache-control": "no-store" });
      upstream.pipe(response);
    });
    forward.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    forward.on("timeout", () => forward.destroy());
    let size = 0;
    request.on("data", chunk => { size += chunk.length; if (size > 8 * 1024 * 1024) { forward.destroy(); request.destroy(); } });
    request.on("aborted", () => forward.destroy());
    request.pipe(forward);
  });
  await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(8787, "0.0.0.0", resolve); });
  Object.assign(process.env, {
    REPORT_FORMAT: "text", HEADLESS_GATEWAY_PORT: "3001", E2B_GATEWAY_PUBLIC_URL: `${process.env.TRACEDOG_GATEWAY_ORIGIN}/gateway`,
    E2B_TEMPLATE_ID: process.env.TRACEDOG_INVESTIGATOR_TEMPLATE_ID ?? "",
    RESEARCH_MODEL: process.env.TRACEDOG_MODEL ?? "deepseek-v4.1-flash", RESEARCH_OPENCODE_PROVIDER: "GO", RESEARCH_REASONING_VARIANT: "medium",
  });
  const output = join(root, "runs");
  let published = false;
  try {
    await runProcess(process.execPath, ["--import", "tsx", "src/headless/cli.ts", job.kind === "pdf" ? "--resume" : "--submission", job.inputPath, "--classification", "public-professional", "--provider-mode", "live", "--runtime", "e2b", "--output", output], { timeoutMs: RUN_TIMEOUT_MS + 60_000, maxOutputBytes: 100_000 });
    const report = await readPublishedText(output);
    published = true;
    const emailId = await retryEmail(job.email, `Your TraceDog ${job.kind === "pdf" ? "PDF" : "text"} investigation report`, report.text, `report-${job.id}`);
    await writeFile(join(root, "outcome.json"), JSON.stringify({ status: "SENT", id: job.id, runId: report.runId, emailId }), { mode: 0o600 });
  } catch (error) {
    await writeFile(join(root, "failure.txt"), error instanceof Error ? error.message : "Investigation failed.", { mode: 0o600 });
    await writeFile(join(root, "outcome.json"), JSON.stringify({ status: published ? "DELIVERY_FAILED" : "FAILED", id: job.id }), { mode: 0o600 });
    if (!published) await retryEmail(job.email, "TraceDog investigation could not be completed", "TraceDog could not complete your investigation. No report or score has been issued. Please try again later.", `failure-${job.id}`).catch(() => undefined);
    process.exitCode = 1;
  } finally {
    proxy.close();
    // Controlled acceptance runs retain their temporary files until the sandbox deadline.
    if (process.env.TRACEDOG_RETAIN_FOR_VERIFICATION !== "true" && process.env.TRACEDOG_COORDINATOR_ID) await Sandbox.kill(process.env.TRACEDOG_COORDINATOR_ID, { apiKey: process.env.E2B_API_KEY }).catch(() => undefined);
  }
} else throw new Error("Expected prepare or run.");
