import blockedEmailDomains from "../../landing/public/email-domains.json" with { type: "json" };
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolveMx } from "node:dns/promises";
import { join } from "node:path";

export class SubmissionError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const consumerDomains = new Set(blockedEmailDomains);

export async function validateWorkEmail(raw: unknown, mxLookup = resolveMx): Promise<string> {
  if (typeof raw !== "string" || raw.length > 254 || !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(raw)) throw new SubmissionError("Enter a valid work email.");
  const email = raw.toLowerCase();
  const domain = email.split("@")[1];
  if (consumerDomains.has(domain) || /(?:^|\.)(?:gmail|yahoo|hotmail|outlook|mailinator|guerrillamail)\./.test(domain)) throw new SubmissionError("Enter your work email, not a personal or disposable address.");
  const records = await mxLookup(domain).catch(() => []);
  if (!records.some((record) => record.exchange && record.exchange !== ".")) throw new SubmissionError("That work domain has no working mail records.");
  return email;
}

export function validateText(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length < 20) throw new SubmissionError("Enter at least 20 characters of public professional information.");
  if (raw.length > 10_000) throw new SubmissionError("Text must be no more than 10,000 characters.");
  if (raw.includes("\0")) throw new SubmissionError("Text contains invalid characters.");
  return raw.trim();
}

export function decodePdf(raw: unknown): Buffer {
  if (typeof raw !== "string" || raw.length > 7 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) throw new SubmissionError("Invalid PDF.");
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length > 5 * 1024 * 1024 || bytes.subarray(0, 5).toString() !== "%PDF-") throw new SubmissionError("Upload a PDF no larger than 5 MB.");
  return bytes;
}

export type Job = {
  id: string; email: string; kind: "pdf" | "text"; createdAt: number; ipHash: string;
  status: "VALIDATING" | "QUEUED" | "RUNNING" | "REPORT_READY" | "SENT" | "FAILED";
  inputPath: string; reportPath?: string; reportEmailId?: string; error?: string;
};

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");

// One process, one worker, one persistent disk. Never configure replicas for this store.
export class SubmissionStore {
  private jobs: Job[];
  private file: string;
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.file = join(root, "jobs.json");
    try { this.jobs = JSON.parse(readFileSync(this.file, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; this.jobs = []; }
    for (const job of this.jobs) {
      if (["RUNNING", "VALIDATING", "VERIFYING"].includes(job.status)) { job.status = "FAILED"; job.error = "Investigation interrupted by a service restart. No success report was issued."; }
      for (const field of ["codeHash", "codeExpires", "attempts"]) delete (job as unknown as Record<string, unknown>)[field];
    }
    this.cleanup();
    this.save();
  }
  private save() {
    writeFileSync(this.file + ".tmp", JSON.stringify(this.jobs), { mode: 0o600 });
    renameSync(this.file + ".tmp", this.file);
  }
  list() { return this.jobs.map((job) => ({ ...job })); }
  get(id: string) { return this.jobs.find((job) => job.id === id); }
  update(id: string, patch: Partial<Job>) { const job = this.get(id); if (!job) throw new SubmissionError("Unknown submission."); Object.assign(job, patch); this.save(); }
  cleanup(now = Date.now()) {
    for (const job of this.jobs) {
      if (now - job.createdAt > 7 * 86400_000) rmSync(join(this.root, job.id), { recursive: true, force: true });
    }
    this.jobs = this.jobs.filter((job) => now - job.createdAt <= 7 * 86400_000);
    this.save();
  }
  create(email: string, kind: "pdf" | "text", content: string | Buffer, ip: string): Job {
    const now = Date.now();
    const recent = this.jobs.filter((job) => now - job.createdAt < 86400_000);
    const domain = email.split("@")[1];
    if (recent.length >= 20 || recent.filter((job) => job.email === email).length >= 2 || recent.filter((job) => job.email.endsWith("@" + domain)).length >= 5 || recent.filter((job) => job.ipHash === digest(ip)).length >= 10) throw new SubmissionError("Daily submission limit reached. Try again tomorrow.", 429);
    if (this.jobs.filter((job) => ["QUEUED", "RUNNING", "VALIDATING"].includes(job.status)).length >= 5) throw new SubmissionError("TraceDog is at capacity. Please try again later.", 429);
    const id = randomBytes(24).toString("base64url");
    const root = join(this.root, id);
    mkdirSync(root, { mode: 0o700 });
    const inputPath = join(root, kind === "pdf" ? "input.pdf" : "input.txt");
    writeFileSync(inputPath, content, { mode: 0o600 });
    const job: Job = { id, email, kind, inputPath, createdAt: now, ipHash: digest(ip), status: "VALIDATING" };
    this.jobs.push(job); this.save();
    return { ...job };
  }
  queue(id: string) {
    const job = this.get(id);
    if (!job || job.status !== "VALIDATING") throw new SubmissionError("Only validated submissions may be queued.");
    job.status = "QUEUED"; this.save();
    return { ...job };
  }
}
