import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubmissionStore, decodePdf, validateWorkEmail, validateText } from "./submissions.ts";

test("work emails reject consumer domains, malformed addresses and domains without mail", async () => {
  const mx = async () => [{ exchange: "mail.example.org", priority: 10 }];
  await assert.rejects(() => validateWorkEmail("person@gmail.com", mx), /work email/);
  await assert.rejects(() => validateWorkEmail("person\n@example.org", mx));
  await assert.rejects(() => validateWorkEmail("person@example.org", async () => []), /mail/);
  assert.equal(await validateWorkEmail("Person@Example.org", mx), "person@example.org");
  assert.throws(() => validateText("x"), /20/);
  assert.throws(() => validateText("x".repeat(10001)), /10,000/);
});

test("PDF input rejects forged types, invalid base64 and files above the byte limit", () => {
  assert.throws(() => decodePdf(Buffer.from("not a PDF").toString("base64")), /PDF/);
  assert.throws(() => decodePdf("!!!!"), /PDF/);
  const oversized = Buffer.alloc(5 * 1024 * 1024 + 1); oversized.write("%PDF-");
  assert.throws(() => decodePdf(oversized.toString("base64")), /5 MB/);
});

test("validated inputs queue without email codes and persist queued work", () => {
  const root = mkdtempSync(join(tmpdir(), "tracedog-test-"));
  try {
    const store = new SubmissionStore(root);
    const job = store.create("a@example.org", "text", "public information to investigate", "ip");
    assert.equal(job.status, "VALIDATING");
    assert.equal("codeHash" in job, false);
    store.queue(job.id);
    assert.equal(store.get(job.id)?.status, "QUEUED");
    assert.throws(() => store.queue(job.id), /validated/);
    const reopened = new SubmissionStore(root);
    assert.equal(reopened.get(job.id)?.status, "QUEUED");
    const next = reopened.create("b@example.org", "text", "another public research question", "ip");
    reopened.update(next.id, { status: "FAILED" });
    assert.throws(() => reopened.queue(next.id), /validated/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy code-based jobs are retired on restart without starting research", () => {
  const root = mkdtempSync(join(tmpdir(), "tracedog-migration-"));
  try {
    const store = new SubmissionStore(root);
    const job = store.create("a@example.org", "text", "public information to investigate", "ip");
    writeFileSync(join(root, "jobs.json"), JSON.stringify([{ ...job, status: "VERIFYING", codeHash: "old", codeExpires: Date.now() + 60000, attempts: 0 }]));
    const reopened = new SubmissionStore(root);
    assert.equal(reopened.get(job.id)?.status, "FAILED");
    assert.equal(readFileSync(join(root, "jobs.json"), "utf8").includes("codeHash"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("restarts fail interrupted jobs and daily quotas prevent unlimited submissions", () => {
  const root = mkdtempSync(join(tmpdir(), "tracedog-test-"));
  try {
    const store = new SubmissionStore(root);
    const first = store.create("a@example.org", "text", "first public research question", "ip");
    store.update(first.id, { status: "RUNNING" });
    assert.equal(new SubmissionStore(root).get(first.id)?.status, "FAILED");
    store.create("a@example.org", "text", "second public research question", "ip");
    assert.throws(() => store.create("a@example.org", "text", "third public research question", "ip"), /limit/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
