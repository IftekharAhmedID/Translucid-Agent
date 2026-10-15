import { Buffer } from "node:buffer";
import blockedEmailDomains from "../../landing/public/email-domains.json" with { type: "json" };

export class SubmissionError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const consumerDomains = new Set(blockedEmailDomains);

export function validateWorkEmailAddress(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 254 || !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(raw)) throw new SubmissionError("Enter a valid work email.");
  const email = raw.toLowerCase();
  const domain = email.split("@")[1];
  if (consumerDomains.has(domain) || /(?:^|\.)(?:gmail|yahoo|hotmail|outlook|mailinator|guerrillamail)\./.test(domain)) throw new SubmissionError("Enter your work email, not a personal or disposable address.");
  return email;
}

export function validateText(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new SubmissionError("Minimum 15 words required.");
  const words = raw.trim().split(/\s+/u).length;
  if (words < 15) throw new SubmissionError("Minimum 15 words required.");
  if (words > 1500) throw new SubmissionError("Maximum 1,500 words allowed.");
  if (raw.includes("\0")) throw new SubmissionError("Text contains invalid characters.");
  return raw.trim();
}

export function decodePdf(raw: unknown): Buffer {
  if (typeof raw !== "string" || raw.length > 7 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) throw new SubmissionError("Invalid PDF.");
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length > 2 * 1024 * 1024 || bytes.subarray(0, 5).toString() !== "%PDF-") throw new SubmissionError("Upload a PDF no larger than 2 MB.");
  return bytes;
}

