import { createHash } from "node:crypto";
import { z } from "zod";

export const lineIdSchema = z.string().regex(/^(?:P[1-9]\d*L[1-9]\d*|A1L[1-9]\d*)$/);
export const lineLayoutSchema = z.enum(["SEMANTIC", "PAGE_NUMBER", "REPEATED_HEADER", "REPEATED_FOOTER", "DECORATIVE_LAYOUT"]);
export const lineRecordSchema = z.object({
  id: lineIdSchema,
  origin: z.enum(["PDF", "SUPPLEMENT"]),
  page: z.number().int().positive().optional(),
  line: z.number().int().positive(),
  text: z.string().min(1),
  layout: lineLayoutSchema,
  duplicateOf: lineIdSchema.optional(),
}).strict();

export const lineCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  lines: z.array(lineRecordSchema),
}).strict();

export type LineRecord = z.infer<typeof lineRecordSchema>;
export type LineCatalog = z.infer<typeof lineCatalogSchema>;

type InputLine = { line: number; text: string };
type InputPage = { page: number; lines: InputLine[] };
type InputDocument = { pages?: InputPage[]; supplementalSubmission?: { lines?: InputLine[] } };

function normalized(text: string): string {
  return text.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function edgeLine(page: InputPage, line: number): boolean {
  const populated = page.lines.filter(({ text }) => text.trim());
  const index = populated.findIndex((candidate) => candidate.line === line);
  return index >= 0 && (index < 3 || index >= populated.length - 3);
}

function pageNumber(text: string): boolean {
  return /^\s*(?:page\s+)?\d+(?:\s*(?:\/|of)\s*\d+)?\s*$/iu.test(text);
}

function decorative(text: string): boolean {
  return text.replace(/[\s.·•_\-–—|/\\:]+/gu, "").replace(/[^\p{L}\p{N}]/gu, "").length === 0;
}

export function buildLineCatalog(input: InputDocument): LineCatalog {
  const pages = input.pages ?? [];
  const all = pages.flatMap((page) => page.lines.filter(({ text }) => text.trim()).map((line) => ({ ...line, page, origin: "PDF" as const })));
  const occurrences = new Map<string, Array<{ id: string; page: number; line: number }>>();
  for (const item of all) {
    const id = `P${item.page.page}L${item.line}`;
    const values = occurrences.get(normalized(item.text)) ?? [];
    values.push({ id, page: item.page.page, line: item.line });
    occurrences.set(normalized(item.text), values);
  }
  const lines: LineRecord[] = all.map((item) => {
    const id = `P${item.page.page}L${item.line}`;
    const duplicate = occurrences.get(normalized(item.text))?.find(({ page, line }) => page < item.page.page || (page === item.page.page && line < item.line));
    let layout: LineRecord["layout"] = "SEMANTIC";
    if (pageNumber(item.text) && edgeLine(item.page, item.line)) layout = "PAGE_NUMBER";
    else if (decorative(item.text)) layout = "DECORATIVE_LAYOUT";
    else if (duplicate && edgeLine(item.page, item.line)) layout = item.line <= 3 ? "REPEATED_HEADER" : "REPEATED_FOOTER";
    return { id, origin: item.origin, page: item.page.page, line: item.line, text: item.text, layout, ...(layout.startsWith("REPEATED_") && duplicate ? { duplicateOf: duplicate.id } : {}) };
  });
  const supplemental = input.supplementalSubmission?.lines?.filter(({ text }) => text.trim()).map((line) => ({
    id: `A1L${line.line}`,
    origin: "SUPPLEMENT" as const,
    line: line.line,
    text: line.text,
    layout: decorative(line.text) ? "DECORATIVE_LAYOUT" as const : "SEMANTIC" as const,
  })) ?? [];
  const combined = [...lines, ...supplemental];
  return lineCatalogSchema.parse({ schemaVersion: 1, fingerprint: digest(combined), lines: combined });
}

export function lineSpan(catalog: LineCatalog, lineIds: readonly string[]): { page?: number; text: string } {
  if (!lineIds.length) throw new Error("A line span requires at least one line.");
  const wanted = new Set(lineIds);
  if (wanted.size !== lineIds.length) throw new Error("A line span cannot contain duplicate line IDs.");
  const selected = catalog.lines.filter(({ id }) => wanted.has(id));
  if (selected.length !== lineIds.length) {
    const missing = lineIds.find((id) => !selected.some((line) => line.id === id));
    throw new Error(`Unknown line ${missing}.`);
  }
  const pages = new Set(selected.map(({ page }) => page));
  const origins = new Set(selected.map(({ origin }) => origin));
  const ordered = [...selected].sort((left, right) => catalog.lines.indexOf(left) - catalog.lines.indexOf(right));
  return { ...(pages.size === 1 && origins.has("PDF") ? { page: [...pages][0] } : {}), text: ordered.map(({ text }) => text).join("\n") };
}

export function lineIdsInOrder(catalog: LineCatalog, lineIds: Iterable<string>): string[] {
  const wanted = new Set(lineIds);
  return catalog.lines.filter(({ id }) => wanted.has(id)).map(({ id }) => id);
}
