import blockedDomains from "../public/email-domains.json";

export type InputKind = "pdf" | "text";
export type SubmissionInput = {
  kind: InputKind;
  pdf: File | null;
  text: string;
  textFile?: File | null;
  email: string;
  website: string;
};

export async function buildSubmission(input: SubmissionInput): Promise<Record<string, string>> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid work email.");
  const domain = email.split("@")[1];
  if (blockedDomains.includes(domain) || /(?:^|\.)(?:gmail|yahoo|hotmail|outlook|mailinator|guerrillamail)\./.test(domain)) throw new Error("Use your work email.");
  const payload: Record<string, string> = { kind: input.kind, email, website: input.website };
  if (input.kind === "text") {
    if (input.textFile && input.textFile.size > 40_000) throw new Error("Choose a text file under 40 KB.");
    const text = input.textFile ? await input.textFile.text() : input.text;
    if (text.trim().length < 20) throw new Error("Enter at least 20 characters.");
    if (text.length > 10_000) throw new Error("Use no more than 10,000 characters.");
    payload.text = text.trim();
  } else {
    if (!input.pdf || !input.pdf.name.toLowerCase().endsWith(".pdf") || input.pdf.size > 5 * 1024 * 1024) throw new Error("Choose a PDF under 5 MB.");
    const bytes = new Uint8Array(await input.pdf.arrayBuffer());
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new Error("Choose a valid PDF.");
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    payload.pdf = btoa(binary);
  }
  return payload;
}
