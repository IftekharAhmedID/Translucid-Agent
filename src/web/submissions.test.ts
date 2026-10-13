import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
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

test("verification expires, caps guesses, consumes codes once and persists queued work", () => {
  const root = mkdtempSync(join(tmpdir(), "tracedog-test-"));
  try {
    const store = new SubmissionStore(root);
    const { job, code } = store.create("a@example.org", "text", "public information to investigate", "ip");
    assert.throws(() => store.verify(job.id, "000000"), /code/);
    store.verify(job.id, code);
    assert.equal(store.get(job.id)?.status, "QUEUED");
    assert.throws(() => store.verify(job.id, code), /code/);
    const reopened = new SubmissionStore(root);
    assert.equal(reopened.get(job.id)?.status, "QUEUED");
    const next = reopened.create("b@example.org", "text", "another public research question", "ip");
    for (let i = 0; i < 5; i++) assert.throws(() => reopened.verify(next.job.id, "bad"), /code/);
    assert.throws(() => reopened.verify(next.job.id, next.code), /code/);
    const expired = reopened.create("c@example.org", "text", "another public research question", "ip");
    assert.throws(() => reopened.verify(expired.job.id, expired.code, Date.now() + 16 * 60_000), /code/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("restarts fail interrupted jobs and daily quotas prevent unlimited submissions", () => {
  const root = mkdtempSync(join(tmpdir(), "tracedog-test-"));
  try {
    const store = new SubmissionStore(root);
    const first = store.create("a@example.org", "text", "first public research question", "ip");
    store.update(first.job.id, { status: "RUNNING" });
    assert.equal(new SubmissionStore(root).get(first.job.id)?.status, "FAILED");
    store.create("a@example.org", "text", "second public research question", "ip");
    assert.throws(() => store.create("a@example.org", "text", "third public research question", "ip"), /limit/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
