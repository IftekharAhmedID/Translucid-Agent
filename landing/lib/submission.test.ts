import assert from "node:assert/strict";
import test from "node:test";
import { buildSubmission } from "./submission.ts";

test("work email and PDF/text inputs keep the existing API contract", async () => {
  const pdf = new File(["%PDF-1.7\nfixture"], "resume.pdf", { type: "application/pdf" });
  const result = await buildSubmission({ kind: "pdf", pdf, text: "", email: "Person@Company.org", website: "" });
  assert.equal(result.email, "person@company.org");
  assert.equal(result.pdf, btoa("%PDF-1.7\nfixture"));
  assert.equal("consent" in result, false);
  const typed = await buildSubmission({ kind: "text", pdf: null, text: " A professional claim to investigate. ", email: "person@company.org", website: "" });
  assert.equal(typed.text, "A professional claim to investigate.");
  const uploaded = await buildSubmission({ kind: "text", pdf: null, text: "", textFile: new File(["Text file content to investigate."], "claims.txt"), email: "person@company.org", website: "" });
  assert.equal(uploaded.text, "Text file content to investigate.");
});

test("personal emails and invalid files are rejected before submission", async () => {
  const input = { kind: "text" as const, pdf: null, text: "A professional claim to investigate.", email: "person@company.org", website: "" };
  for (const domain of ["gmail.com", "yahoo.com", "yahoo.de", "outlook.com", "icloud.com", "proton.me"]) {
    await assert.rejects(() => buildSubmission({ ...input, email: `person@${domain}` }), /work email/i);
  }
  await assert.rejects(() => buildSubmission({ ...input, kind: "pdf" }), /choose a PDF/i);
  await assert.rejects(() => buildSubmission({ ...input, kind: "pdf", pdf: new File(["x"], "fake.pdf") }), /valid PDF/i);
  await assert.rejects(() => buildSubmission({ ...input, text: "short" }), /20/);
  await assert.rejects(() => buildSubmission({ ...input, text: "x".repeat(10_001) }), /10,000/);
  await assert.rejects(() => buildSubmission({ ...input, textFile: new File(["x".repeat(40_001)], "large.txt") }), /40 KB/);
});
