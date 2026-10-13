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
  transform?: number[];
  width?: number;
  height?: number;
  dir?: string;
};

export type PdfStructuredLine = { line: number; text: string; bounds?: [number, number, number, number] };

function itemBounds(item: PdfTextItem): PdfStructuredLine["bounds"] {
  const t = item.transform;
  if (!t || t.length !== 6 || !t.every(Number.isFinite) || t[0]! <= 0 || t[3]! <= 0 || t[1] !== 0 || t[2] !== 0 || item.dir === "rtl" || item.dir === "ttb") return undefined;
  if (!Number.isFinite(item.width) || !Number.isFinite(item.height) || item.width! < 0 || item.height! <= 0) return undefined;
  return [t[4]!, t[5]!, t[4]! + item.width!, t[5]! + item.height!];
}

export function pdfTextItemsToStructuredLines(items: PdfTextItem[]): PdfStructuredLine[] {
  const lines: PdfStructuredLine[] = [];
  let line = "";
  let bounds: PdfStructuredLine["bounds"];
  let previous: PdfStructuredLine["bounds"];
  let geometryComplete = true;
  const flush = () => {
    const normalized = line.replace(/\s+/g, " ").trim();
    if (normalized) lines.push({ line: lines.length + 1, text: normalized, ...(bounds ? { bounds } : {}) });
    line = "";
    bounds = undefined;
    previous = undefined;
    geometryComplete = true;
  };

  for (const item of items) {
    const current = item.str.trim() ? itemBounds(item) : undefined;
    if (item.str.trim() && !current) {
      geometryComplete = false;
      bounds = undefined;
      previous = undefined;
    }
    if (geometryComplete && current && previous) {
      const height = Math.min(current[3] - current[1], previous[3] - previous[1]);
      if (Math.abs(current[1] - previous[1]) > Math.max(2, height * 0.4)) flush();
      else if (current[0] - previous[2] > Math.max(0.5, height * 0.15) && !/\s$/.test(line) && !/^\s/.test(item.str)) line += " ";
    }
    line += item.str;
    if (geometryComplete && current) {
      bounds = bounds ? [Math.min(bounds[0], current[0]), Math.min(bounds[1], current[1]), Math.max(bounds[2], current[2]), Math.max(bounds[3], current[3])] : current;
      previous = current;
    }
    if (item.hasEOL) flush();
  }
  flush();
  return lines;
}

export function pdfTextItemsToLines(items: PdfTextItem[]): string[] {
  return pdfTextItemsToStructuredLines(items).map(({ text }) => text);
}

export function buildPdfSections(pages: Array<{ page: number; lines: PdfStructuredLine[] }>) {
  const sections: Array<{ heading: string | null; ranges: Array<{ page: number; lineStart: number; lineEnd: number }> }> = [];
  const heading = /^(education|skills|(?:working|work|professional|research|project) experience|experience|projects|publications?|achievements?|awards(?: and honors)?|certifications?|summary|objective|leadership|volunteering|interests):?$/i;
  for (const page of pages) for (const line of page.lines) {
    if (!sections.length || heading.test(line.text)) sections.push({ heading: heading.test(line.text) ? line.text : null, ranges: [] });
    const ranges = sections.at(-1)!.ranges;
    const last = ranges.at(-1);
    if (last?.page === page.page) last.lineEnd = line.line;
    else ranges.push({ page: page.page, lineStart: line.line, lineEnd: line.line });
  }
  return sections;
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
