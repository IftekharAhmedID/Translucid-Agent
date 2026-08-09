import { createHash } from "node:crypto";

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_PAGES = 50;
export const MAX_SUBMISSION_BYTES = 1024 * 1024;
export const SPARSE_PAGE_CHARACTER_LIMIT = 80;
export const SPARSE_DOCUMENT_CHARACTER_LIMIT = 300;

export type NormalizedSubmission = {
  kind: "JSON" | "TEXT";
  raw: string;
  normalized: string;
  byteLength: number;
};

export function normalizeSubmission(raw: string): NormalizedSubmission {
  const byteLength = Buffer.byteLength(raw);
  if (!raw.trim()) {
    throw new Error("Submission is required.");
  }
  if (byteLength > MAX_SUBMISSION_BYTES) {
    throw new Error("Submission exceeds the 1 MiB limit.");
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return {
      kind: "JSON",
      raw,
      normalized: JSON.stringify(parsed, null, 2),
      byteLength,
    };
  } catch {
    return { kind: "TEXT", raw, normalized: raw, byteLength };
  }
}

export function validatePdfBytes(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new Error("PDF exceeds the 20 MiB limit.");
  }
  if (bytes.byteLength < 5 || Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-") {
    throw new Error("File does not contain PDF magic bytes.");
  }
}

export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isSparsePage(text: string): boolean {
  return text.replace(/\s/g, "").length < SPARSE_PAGE_CHARACTER_LIMIT;
}

export function isSparseDocument(pageTexts: string[]): boolean {
  return pageTexts.join("").replace(/\s/g, "").length < SPARSE_DOCUMENT_CHARACTER_LIMIT;
}
