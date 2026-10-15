import assert from "node:assert/strict";
import test from "node:test";
import { buildSubmission } from "./submission.ts";

const text = Array.from({ length: 15 }, (_, index) => `word${index}`).join(" ");

test("work email and PDF/text inputs keep the existing API contract", async () => {
  const pdf = new File(["%PDF-1.7\nfixture"], "resume.pdf", { type: "application/pdf" });
  const result = await buildSubmission({ kind: "pdf", pdf, text: "", email: "Person@Company.org", website: "" });
  assert.equal(result.email, "person@company.org");
  assert.equal(result.pdf, btoa("%PDF-1.7\nfixture"));
  assert.equal("consent" in result, false);
  const typed = await buildSubmission({ kind: "text", pdf: null, text: ` ${text} `, email: "person@company.org", website: "" });
  assert.equal(typed.text, text);
  const uploaded = await buildSubmission({ kind: "text", pdf: null, text: "", textFile: new File([text], "claims.txt"), email: "person@company.org", website: "" });
  assert.equal(uploaded.text, text);
});

test("personal emails and invalid files are rejected before submission", async () => {
  const input = { kind: "text" as const, pdf: null, text, email: "person@company.org", website: "" };
  for (const domain of ["gmail.com", "yahoo.com", "yahoo.de", "outlook.com", "icloud.com", "proton.me"]) {
    await assert.rejects(() => buildSubmission({ ...input, email: `person@${domain}` }), /work email/i);
  }
  await assert.rejects(() => buildSubmission({ ...input, kind: "pdf" }), /choose a PDF/i);
  await assert.rejects(() => buildSubmission({ ...input, kind: "pdf", pdf: new File(["x"], "fake.pdf") }), /valid PDF/i);
  await assert.rejects(() => buildSubmission({ ...input, text: "word ".repeat(10), email: "" }), /Minimum 15 words required/);
  await assert.rejects(() => buildSubmission({ ...input, text: "word ".repeat(1501) }), /Maximum 1,500 words/);
  await assert.rejects(() => buildSubmission({ ...input, textFile: new File(["x".repeat(40_001)], "large.txt") }), /40 KB/);
});

test("text accepts exactly 15 through 1,500 words including varied whitespace", async () => {
  const input = { kind: "text" as const, pdf: null, email: "person@company.org", website: "" };
  await assert.rejects(() => buildSubmission({ ...input, text: "word ".repeat(14) }), /15 words/);
  for (const count of [15, 1500]) {
    const text = Array.from({ length: count }, () => "professional").join(" \t\n");
    assert.equal((await buildSubmission({ ...input, text })).text, text);
  }
  await assert.rejects(() => buildSubmission({ ...input, text: "", textFile: new File(["word ".repeat(14)], "short.txt") }), /15 words/);
});
