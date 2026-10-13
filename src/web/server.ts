import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SubmissionError, SubmissionStore, decodePdf, validateText, validateWorkEmail, type Job } from "./submissions.ts";
import { sendEmail } from "./email.ts";
import { runProcess } from "../runtime/process.ts";
import { directoryBytes, hasCaseSpace } from "./storage.ts";

const root = resolve(process.env.TRACEDOG_DATA_DIR ?? ".debug/tracedog-web");
const store = new SubmissionStore(root);
const origin = process.env.TRACEDOG_ORIGIN ?? "http://127.0.0.1:8787";
const enabled = () => process.env.TRACEDOG_ACCEPT_SUBMISSIONS === "true" && process.env.TRACEDOG_DURABLE_STORAGE === "true" && Boolean(process.env.E2B_API_KEY && process.env.E2B_TEMPLATE_ID && process.env.RESEND_API_KEY && process.env.RESEND_FROM && process.env.OPENCODE_API_KEY);
const gatewayPort = 3001;
let active = false;
let stopping = false;
let child: ReturnType<typeof spawn> | undefined;
let nextDelivery = 0;
let requestWindow = { starts: Date.now(), count: 0 };
let acceptingUpload = false;

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage, maximum = 7 * 1024 * 1024) {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw new SubmissionError("Upload is too large.", 413);
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; }
  catch { throw new SubmissionError("Invalid request."); }
}

async function validatePdf(job: Job) {
  const { stdout } = await runProcess("pdfinfo", [job.inputPath], { timeoutMs: 10000, maxOutputBytes: 100000 });
  const pages = Number(stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
  if (!pages || pages > 20 || /^Encrypted:\s+yes/m.test(stdout)) throw new SubmissionError("Use an unencrypted PDF with at most 20 pages.");
  const extracted = await runProcess("pdftotext", ["-f", "1", "-l", "20", job.inputPath, "-"], { timeoutMs: 10000, maxOutputBytes: 400000 });
  if (extracted.stdout.trim().length < 20 || extracted.stdout.length > 100000) throw new SubmissionError("Use a text-bearing PDF with at most 100,000 extracted characters. Scanned images are not supported.");
}

async function investigate(job: Job) {
  store.update(job.id, { status: "RUNNING" });
  const output = join(root, job.id, "runs");
  const input = job.kind === "pdf" ? "--resume" : "--submission";
  const model = process.env.TRACEDOG_MODEL ?? process.env.RESEARCH_MODEL ?? "deepseek-v4-pro";
  const variant = model === "big-pickle" ? "default" : job.kind === "text" ? "medium" : process.env.TRACEDOG_PDF_REASONING ?? process.env.RESEARCH_REASONING_VARIANT ?? "medium";
  let stderr = "";
  let checkingStorage = false;
  const storageTimer = setInterval(async () => {
    if (checkingStorage) return;
    checkingStorage = true;
    try {
      if (await directoryBytes(join(root, job.id)) > 64 * 1024 * 1024 || !await hasCaseSpace(root)) child?.kill("SIGTERM");
    } catch { child?.kill("SIGTERM"); }
    finally { checkingStorage = false; }
  }, 2000);
  try {
    await new Promise<void>((done, reject) => {
      child = spawn(process.execPath, ["--import", "tsx", "src/headless/cli.ts", input, job.inputPath, "--classification", "public-professional", "--provider-mode", "live", "--runtime", "e2b", "--output", output], {
        env: { ...process.env, RESEARCH_MODEL: model, RESEARCH_OPENCODE_PROVIDER: model === "big-pickle" || model === "cat-jam-free" ? "ZEN" : process.env.RESEARCH_OPENCODE_PROVIDER ?? "GO", RESEARCH_REASONING_VARIANT: variant, REPORT_FORMAT: "text", HEADLESS_GATEWAY_PORT: String(gatewayPort), E2B_GATEWAY_PUBLIC_URL: origin + "/gateway" },
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? done() : reject(new Error("Investigation failed.")));
    });
    const directories = await readdir(output, { withFileTypes: true });
    let reportPath: string | undefined;
    for (const directory of directories) if (directory.isDirectory()) {
      const candidate = join(output, directory.name);
      await readFile(join(candidate, "result.json"));
      reportPath = join(candidate, "report.txt");
    }
    if (!reportPath) throw new Error("No committed report.");
    store.update(job.id, { status: "REPORT_READY", reportPath });
  } catch {
    await rm(output, { recursive: true, force: true }).catch(() => undefined);
    store.update(job.id, { status: "FAILED", error: "The investigation could not be completed. No score was issued." });
    // Internal diagnostics remain private; never send raw model/provider errors to the user.
    if (stderr) console.error("TraceDog investigation failed", job.id);
    await sendEmail(job.email, "TraceDog investigation could not be completed", "TraceDog could not complete your investigation. No report or score has been issued. Please try again later.", "failure-" + job.id).catch(() => undefined);
  } finally { clearInterval(storageTimer); child = undefined; }
}

async function pump() {
  if (active || stopping || !enabled()) return;
  active = true;
  try {
    const ready = store.list().find((job) => job.status === "REPORT_READY");
    if (ready && Date.now() >= nextDelivery) {
      try {
        await sendEmail(ready.email, "Your TraceDog investigation report", await readFile(ready.reportPath!, "utf8"), "report-" + ready.id);
        store.update(ready.id, { status: "SENT" });
      } catch { nextDelivery = Date.now() + 60000; }
    }
    const job = store.list().find((job) => job.status === "QUEUED");
    if (job && await hasCaseSpace(root)) await investigate(job);
  } finally { active = false; }
}

const files: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"], "/style.css": ["style.css", "text/css"],
  "/app.js": ["app.js", "text/javascript"], "/mark.svg": ["mark.svg", "image/svg+xml"],
  "/robots.txt": ["robots.txt", "text/plain"], "/sitemap.xml": ["sitemap.xml", "application/xml"],
};

export const server = createServer(async (request, response) => {
  let ownsUpload = false;
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  response.setHeader("content-security-policy", "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  try {
    const path = new URL(request.url ?? "/", origin).pathname;
    if (path === "/health") return json(response, 200, { status: "ok", submissionsEnabled: enabled() });
    if (path.startsWith("/gateway/")) {
      if (!active || !child || request.method !== "POST" || !["/gateway/internal/tools/execute", "/gateway/internal/llm/v1/chat/completions", "/gateway/internal/llm/v1/responses"].includes(path) || !request.headers.authorization) return json(response, 404, { error: "Not found." });
      const forward = httpRequest({ hostname: "127.0.0.1", port: gatewayPort, path: path.slice("/gateway".length), method: "POST", headers: { ...request.headers, host: "127.0.0.1" }, timeout: 360000 }, (upstream) => { response.writeHead(upstream.statusCode ?? 502, { "content-type": upstream.headers["content-type"] ?? "application/json", "cache-control": "no-store" }); upstream.pipe(response); });
      forward.on("error", () => { if (!response.headersSent) json(response, 502, { error: "Gateway unavailable." }); else response.destroy(); });
      forward.on("timeout", () => forward.destroy());
      let size = 0;
      request.on("data", (chunk) => { size += chunk.length; if (size > 8 * 1024 * 1024) { forward.destroy(); request.destroy(); } });
      request.on("aborted", () => forward.destroy());
      return void request.pipe(forward);
    }
    if (path.startsWith("/api/")) {
      if (Date.now() - requestWindow.starts > 60000) requestWindow = { starts: Date.now(), count: 0 };
      if (++requestWindow.count > 60) throw new SubmissionError("Too many requests. Try again shortly.", 429);
      if (request.method !== "POST" || request.headers.origin !== origin || !request.headers["content-type"]?.startsWith("application/json")) throw new SubmissionError("Request not allowed.", 403);
      if (!enabled()) throw new SubmissionError("Investigations are temporarily unavailable while we complete runtime checks.", 503);
      if (path === "/api/submissions") {
        if (acceptingUpload) throw new SubmissionError("Another upload is being validated. Try again shortly.", 429);
        acceptingUpload = true; ownsUpload = true;
      }
      const value = await body(request, path === "/api/submissions" ? 7 * 1024 * 1024 : 1024);
      // Shared edge addresses may make this quota conservative. Global/domain/email quotas also bound cost.
      const ip = request.socket.remoteAddress ?? "unknown";
      if (path === "/api/submissions") {
        if (value.website || value.consent !== true) throw new SubmissionError("Confirm you may submit this public professional information.");
        if (!await hasCaseSpace(root)) throw new SubmissionError("TraceDog storage is at capacity. Please try again later.", 503);
        const email = await validateWorkEmail(value.email);
        const kind = value.kind === "pdf" ? "pdf" : value.kind === "text" ? "text" : undefined;
        if (!kind) throw new SubmissionError("Choose PDF or text.");
        let content: string | Buffer;
        if (kind === "text") content = validateText(value.text);
        else {
          content = decodePdf(value.pdf);
        }
        const { job, code } = store.create(email, kind, content, ip);
        try {
          if (kind === "pdf") await validatePdf(job);
          await sendEmail(email, "Verify your work email for TraceDog", `Your TraceDog verification code is ${code}. It expires in 15 minutes. Enter it on the page where you submitted your investigation.\n\nYour plain-text report will be sent to this work email after the investigation. If you did not request this, ignore this email; the investigation will not start.`, "verify-" + job.id);
        } catch (error) {
          store.update(job.id, { status: "FAILED", codeHash: "" });
          await rm(job.inputPath, { force: true });
          throw error instanceof SubmissionError ? error : new SubmissionError("PDF could not be read. Use a valid text-bearing PDF.");
        }
        return json(response, 202, { submissionId: job.id, message: "Check your work email for a verification code." });
      }
      if (path === "/api/verify") {
        if (typeof value.submissionId !== "string" || typeof value.code !== "string") throw new SubmissionError("Enter your verification code.");
        store.verify(value.submissionId, value.code);
        void pump().catch(() => console.error("TraceDog worker unavailable"));
        return json(response, 202, { message: "TraceDog is queued. We will email your plain-text report when it is ready." });
      }
      return json(response, 404, { error: "Not found." });
    }
    if (!["GET", "HEAD"].includes(request.method ?? "") || !files[path]) return json(response, 404, { error: "Not found." });
    const [file, type] = files[path];
    const bytes = await readFile(resolve("landing/public", file));
    response.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
    response.end(request.method === "HEAD" ? undefined : bytes);
  } catch (error) {
    if (!response.headersSent) json(response, error instanceof SubmissionError ? error.status : 500, { error: error instanceof SubmissionError ? error.message : "TraceDog could not process that request." });
  } finally { if (ownsUpload) acceptingUpload = false; }
});

server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.listen(Number(process.env.PORT ?? 8787), "0.0.0.0", () => console.log("TraceDog web service listening"));
const timer = setInterval(() => {
  try { store.cleanup(); }
  catch { console.error("TraceDog storage unavailable"); return; }
  void pump().catch(() => console.error("TraceDog worker unavailable"));
}, 10000);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  stopping = true; clearInterval(timer); child?.kill("SIGTERM"); server.close();
});
