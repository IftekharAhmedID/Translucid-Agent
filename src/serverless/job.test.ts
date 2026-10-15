import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareJob, retryEmail, readPublishedText } from "./job.ts";

test("detached job validates before accepting input and keeps only the prepared input", async () => {
  const root = await mkdtemp(join(tmpdir(), "tracedog-job-"));
  const mx = async () => [{ exchange: "mx.example.org", priority: 10 }];
  const payload = { kind: "text", text: "word ".repeat(15), email: "person@company.org" };
  try {
    await assert.rejects(() => prepareJob(root, "job-test", { ...payload, text: "short" }, mx), /15 words/);
    await assert.rejects(() => prepareJob(root, "job-test", { ...payload, email: "person@gmail.com" }, mx), /work email/);
    await assert.rejects(() => prepareJob(root, "../escape", payload, mx), /job identifier/);
    const job = await prepareJob(root, "job-test", payload, mx);
    assert.equal(await readFile(job.inputPath, "utf8"), payload.text.trim());
    assert.equal(job.email, payload.email);
    assert.equal((JSON.parse(await readFile(join(root, "job.json"), "utf8"))).id, "job-test");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("email retries preserve the idempotency key and stop after bounded attempts", async () => {
  let attempts = 0;
  const keys: string[] = [];
  const send = async (_to: string, _subject: string, _text: string, key: string) => {
    keys.push(key);
    if (++attempts < 3) throw new Error("Temporary provider failure");
    return "email-id";
  };
  assert.equal(await retryEmail("person@company.org", "Report", "Findings", "report-job", send, async () => {}), "email-id");
  assert.deepEqual(keys, ["report-job", "report-job", "report-job"]);
  let failures = 0;
  await assert.rejects(() => retryEmail("person@company.org", "Report", "Findings", "report-job", async () => { failures++; throw new Error("Unavailable"); }, async () => {}), /Unavailable/);
  assert.equal(failures, 4);
});

test("unpublished output cannot become a success email", async () => {
  const root = await mkdtemp(join(tmpdir(), "tracedog-unpublished-"));
  try { await assert.rejects(() => readPublishedText(root)); }
  finally { await rm(root, { recursive: true, force: true }); }
});
