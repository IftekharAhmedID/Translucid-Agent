import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodePdf, SubmissionError, validatePdfFile, validateText, validateWorkEmail } from "../web/submissions.ts";
import { sendEmail } from "../web/email.ts";
import { leanReportResultSchema } from "../headless/report-store.ts";
import { researchSnapshotSha256, verifyResearchSnapshot } from "../headless/research-state.ts";

export type PreparedJob = { id: string; kind: "pdf" | "text"; email: string; inputPath: string };

export async function prepareJob(root: string, id: string, payload: Record<string, unknown>, mxLookup?: Parameters<typeof validateWorkEmail>[1]): Promise<PreparedJob> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new SubmissionError("Invalid job identifier.");
  if (payload.website) throw new SubmissionError("Submission could not be accepted.");
  const email = await validateWorkEmail(payload.email, mxLookup);
  const kind = payload.kind;
  if (kind !== "text" && kind !== "pdf") throw new SubmissionError("Choose PDF or text.");
  const content = kind === "text" ? validateText(payload.text) : decodePdf(payload.pdf);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const inputPath = join(root, kind === "text" ? "input.txt" : "input.pdf");
  await writeFile(inputPath, content, { mode: 0o600 });
  try { if (kind === "pdf") await validatePdfFile(inputPath); }
  catch (error) {
    await rm(inputPath, { force: true });
    throw error instanceof SubmissionError ? error : new SubmissionError("PDF could not be read. Use a valid text-bearing PDF.");
  }
  const job: PreparedJob = { id, kind, email, inputPath };
  await writeFile(join(root, "job.json"), JSON.stringify(job), { mode: 0o600 });
  return job;
}

export async function retryEmail(to: string, subject: string, text: string, key: string, send = sendEmail, sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try { return await send(to, subject, text, key); }
    catch (error) {
      if (attempt === 3) throw error;
      await sleep([2_000, 10_000, 30_000][attempt]);
    }
  }
}

export async function readPublishedText(output: string): Promise<{ text: string; runId: string }> {
  const entries = (await readdir(output, { withFileTypes: true })).filter(entry => entry.isDirectory());
  if (entries.length !== 1) throw new Error("Expected one published investigation.");
  const root = join(output, entries[0].name);
  const state = JSON.parse(await readFile(join(root, ".work/research-state.json"), "utf8"));
  if (state.phase !== "COMMITTED") throw new Error("Investigation is not committed.");
  await verifyResearchSnapshot(root);
  const result = leanReportResultSchema.parse(JSON.parse(await readFile(join(root, "result.json"), "utf8")));
  if (result.schemaVersion !== 4 || !("researchSnapshotSha256" in result) || result.researchSnapshotSha256 !== await researchSnapshotSha256(root)) throw new Error("Published snapshot does not match.");
  const text = await readFile(join(root, "report.txt"), "utf8");
  const provenance = JSON.parse(await readFile(join(root, "provenance/report.json"), "utf8"));
  if (!text.trim() || provenance.artifact?.sha256 !== createHash("sha256").update(text).digest("hex")) throw new Error("Published report integrity failed.");
  return { text, runId: entries[0].name };
}
