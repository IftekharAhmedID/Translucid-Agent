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

export function wrapExtractedText(text: string, width = 160): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (!line) line = word;
    else if (line.length + word.length + 1 <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

export type PdfTextItem = {
  str: string;
  hasEOL?: boolean;
};

export function pdfTextItemsToLines(items: PdfTextItem[]): string[] {
  const lines: string[] = [];
  let line = "";
  const flush = () => {
    const normalized = line.replace(/\s+/g, " ").trim();
    if (normalized) lines.push(normalized);
    line = "";
  };

  for (const item of items) {
    line += item.str;
    if (item.hasEOL) flush();
  }
  flush();
  return lines;
}

export function buildAgentInputManifest(
  seed: Record<string, unknown> & { pdfPath?: unknown; pdfSha256?: unknown },
  parsedDocument?: Record<string, unknown>,
): Record<string, unknown> {
  const safeSeed = { ...seed };
  const pdfSha256 = safeSeed.pdfSha256;
  delete safeSeed.pdfPath;
  delete safeSeed.pdfSha256;
  return {
    ...safeSeed,
    parsedDocument: parsedDocument ? {
      ...parsedDocument,
      ...(typeof pdfSha256 === "string" ? { sourceSha256: pdfSha256 } : {}),
      sourceType: "PDFJS_STRUCTURED_TEXT",
      rawPdfAvailableToAgent: false,
    } : undefined,
    generatedAt: new Date().toISOString(),
  };
}
