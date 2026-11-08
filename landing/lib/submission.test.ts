import assert from "node:assert/strict";
import test from "node:test";
import { buildSubmission, countWords } from "./submission.ts";

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
  const oversized = new Uint8Array(2 * 1024 * 1024 + 1); oversized.set(new TextEncoder().encode("%PDF-"));
  await assert.rejects(() => buildSubmission({ ...input, kind: "pdf", pdf: new File([oversized], "large.pdf") }), /2 MB/);
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

test("LinkedIn profiles and social IDs use the existing text submission contract", async () => {
  const input = { pdf: null, text: "stale text", email: "person@company.org", website: "" };
  const linkedin = await buildSubmission({ ...input, kind: "linkedin", profile: "linkedin.com/in/nora-chen/?trk=test" });
  assert.equal(linkedin.kind, "text");
  assert.match(linkedin.text, /LinkedIn profile: https:\/\/linkedin.com\/in\/nora-chen\//);
  assert.ok(!linkedin.text.includes("trk=test") && !linkedin.text.includes("stale text"));
  for (const socialId of ["Instagram @nora.chen", "https://x.com/nora_chen"]) {
    const result = await buildSubmission({ ...input, kind: "social", socialId });
    assert.equal(result.kind, "text");
    assert.ok(result.text.includes(socialId));
    assert.ok(countWords(result.text) >= 15 && countWords(result.text) <= 1500);
  }
  for (const profile of ["", "https://linkedin.com.evil.test/in/nora", "https://linkedin.com/company/aster", "javascript:alert(1)"]) {
    await assert.rejects(() => buildSubmission({ ...input, kind: "linkedin", profile }), /LinkedIn profile/);
  }
  await assert.rejects(() => buildSubmission({ ...input, kind: "social", socialId: "@nora" }), /platform/);
  await assert.rejects(() => buildSubmission({ ...input, kind: "social", socialId: "http://localhost/profile" }), /profile URL/);
  await assert.rejects(() => buildSubmission({ ...input, kind: "linkedin", profile: "https://linkedin.com/in/nora", email: "nora@gmail.com" }), /work email/i);
});

test("Person requires name and context, accepts an optional claim, and preserves supplied details", async () => {
  const person = { name: "Nora Chen", context: "Aster Labs", claim: "Led the engineering team." };
  const input = { kind: "person" as const, person, pdf: null, text: "stale text", email: "person@company.org", website: "" };
  const result = await buildSubmission(input);
  assert.equal(result.kind, "text");
  assert.match(result.text, /Name: Nora Chen\nWorkplace or school: Aster Labs\nClaim: Led the engineering team\./);
  assert.ok(countWords(result.text) >= 15 && !result.text.includes("stale text"));
  for (const [field, message] of [["name", /name/i], ["context", /workplace or school/i]] as const) {
    await assert.rejects(() => buildSubmission({ ...input, person: { ...person, [field]: "  " } }), message);
  }
  for (const claim of [undefined, "", "  "]) {
    const withoutClaim = await buildSubmission({ ...input, person: { ...person, claim } });
    assert.match(withoutClaim.text, /Name: Nora Chen\nWorkplace or school: Aster Labs$/);
    assert.ok(!withoutClaim.text.includes("Claim:") && countWords(withoutClaim.text) >= 15);
  }
  await assert.rejects(() => buildSubmission({ ...input, person: { ...person, claim: "word ".repeat(1501) } }), /1,500 words/);
  await assert.rejects(() => buildSubmission({ ...input, email: "nora@yahoo.com" }), /work email/i);
});
