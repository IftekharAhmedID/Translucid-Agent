import assert from "node:assert/strict";
import test from "node:test";
import { sendEmail } from "./email.ts";

test("Resend sends only plain text with a stable idempotency key", async () => {
  const previous = { key: process.env.RESEND_API_KEY, from: process.env.RESEND_FROM };
  process.env.RESEND_API_KEY = "test-key";
  process.env.RESEND_FROM = "TraceDog <reports@example.org>";
  try {
    let request: RequestInit | undefined;
    assert.equal(await sendEmail("user@work.org", "Report", "Findings and sources", "report-job", async (_url, init) => {
      request = init; return Response.json({ id: "email-id" });
    }), "email-id");
    const payload = JSON.parse(String(request?.body));
    assert.equal(payload.text, "Findings and sources");
    assert.equal(payload.html, undefined);
    assert.equal(payload.attachments, undefined);
    assert.equal((request?.headers as Record<string, string>)["idempotency-key"], "report-job");
    await assert.rejects(() => sendEmail("user@work.org", "Report", "Text", "report-job", async () => Response.json({}, { status: 429 })), /delivered/);
  } finally {
    if (previous.key) process.env.RESEND_API_KEY = previous.key; else delete process.env.RESEND_API_KEY;
    if (previous.from) process.env.RESEND_FROM = previous.from; else delete process.env.RESEND_FROM;
  }
});
