import PDFDocument from "pdfkit";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { leanReportResultSchema, type LeanReportResult } from "./report-store.ts";

const findingStatusLabels: Record<LeanReportResult["findings"][number]["status"], string> = {
  [-2]: "Contradicted",
  [-1]: "Conflicting evidence",
  [0]: "Unresolved / insufficient evidence",
  [1]: "Partially established",
  [2]: "Established",
};

const displayPunctuation: Record<string, string> = {
  "\u00a0": " ", "\u2018": "'", "\u2019": "'", "\u201c": "\"", "\u201d": "\"",
  "\u2013": "-", "\u2014": "-", "\u2212": "-", "\u2026": "...", "\u2022": "*",
  "\u2192": "->", "\u2190": "<-", "\u2194": "<->", "\u21d2": "=>", "\u21d0": "<=", "\u21d4": "<=>", "\u00d7": "x",
};

const unsupportedLetters: Record<string, string> = {
  "\u0141": "L", "\u0142": "l", "\u0110": "D", "\u0111": "d", "\u0126": "H", "\u0127": "h", "\u0131": "i", "\u0138": "k",
  "\u013f": "L", "\u0140": "l", "\u014a": "N", "\u014b": "n", "\u0152": "OE", "\u0153": "oe", "\u0166": "T", "\u0167": "t",
  "\u00d8": "O", "\u00f8": "o", "\u00de": "TH", "\u00fe": "th", "\u00df": "ss", "\u00c6": "AE", "\u00e6": "ae",
};

function isWinAnsiSafe(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff);
}

/** Convert only PDF display text; source blobs and result.json retain raw Unicode. */
export function pdfDisplayText(value: string): string {
  let output = "";
  for (const character of value) {
    const punctuation = displayPunctuation[character];
    if (punctuation !== undefined) {
      output += punctuation;
      continue;
    }
    if (isWinAnsiSafe(character)) {
      output += character;
      continue;
    }
    const mapped = unsupportedLetters[character];
    if (mapped !== undefined) {
      output += mapped;
      continue;
    }
    const decomposed = character.normalize("NFKD").replace(/\p{M}/gu, "");
    if (decomposed !== character && [...decomposed].every(isWinAnsiSafe)) {
      output += decomposed;
      continue;
    }
    output += "?";
  }
  return output;
}

type Finding = LeanReportResult["findings"][number];

function sortedFindings(result: LeanReportResult): Finding[] {
  return [...result.findings].sort((left, right) => {
    if (left.anchor.kind !== right.anchor.kind) return left.anchor.kind === "PDF_TEXT" ? -1 : 1;
    if (left.anchor.kind === "PDF_TEXT" && right.anchor.kind === "PDF_TEXT") {
      return left.anchor.page - right.anchor.page || left.anchor.lineStart - right.anchor.lineStart || left.order - right.order;
    }
    return left.order - right.order;
  });
}

function sourceLabel(source: { sourceRef: string; title?: string; url?: string }): string {
  return source.title ? `${source.title} (${source.sourceRef})` : source.sourceRef;
}

async function render(value: LeanReportResult, mode: "recruiter" | "audit"): Promise<Buffer> {
  const result = leanReportResultSchema.parse(value);
  const startedAt = new Date(result.run.startedAt);
  const completedAt = new Date(result.run.completedAt);
  if (!Number.isFinite(startedAt.getTime()) || !Number.isFinite(completedAt.getTime())) throw new Error("Report timestamps are invalid.");
  const document = new PDFDocument({
    autoFirstPage: false,
    size: "LETTER",
    margins: { top: 54, right: 54, bottom: 54, left: 54 },
    info: {
      Title: `Translucid ${mode === "recruiter" ? "Recruiter Brief" : "Investigation Audit"} ${result.run.id}`,
      Author: "Translucid",
      Subject: mode === "recruiter" ? "Compact recruiter investigation brief" : "Complete investigator evidence audit",
      Creator: "Translucid deterministic report",
      Producer: "Translucid deterministic report",
      CreationDate: startedAt,
      ModDate: completedAt,
    },
  });
  const chunks: Buffer[] = [];
  document.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const completed = new Promise<Buffer>((resolve, reject) => {
    document.once("end", () => resolve(Buffer.concat(chunks)));
    document.once("error", reject);
  });
  const ensureSpace = (points: number) => {
    if (document.y + points > document.page.height - document.page.margins.bottom) document.addPage();
  };
  const heading = (text: string) => document.moveDown(0.8).font("Helvetica-Bold").fontSize(15).fillColor("#14213D").text(pdfDisplayText(text)).moveDown(0.35);
  const subheading = (text: string) => document.moveDown(0.25).font("Helvetica-Bold").fontSize(10.5).fillColor("#14213D").text(pdfDisplayText(text)).moveDown(0.15);
  const label = (text: string) => document.font("Helvetica-Bold").fontSize(8.8).fillColor("#65758B").text(pdfDisplayText(text)).moveDown(0.1);
  const paragraph = (text: string) => document.font("Helvetica").fontSize(9.3).fillColor("#273449").text(pdfDisplayText(text || "Not available"), { lineGap: 2 }).moveDown(0.4);
  const sourceList = (finding: Finding, limit?: number) => {
    const sources = limit === undefined ? finding.sources : finding.sources.slice(0, limit);
    if (!sources.length) {
      paragraph("No captured source cited.");
      return;
    }
    for (const [index, source] of sources.entries()) {
      const prefix = `(${index + 1}) ${sourceLabel(source)}`;
      if (source.url) {
        document.font("Helvetica").fontSize(8.8).fillColor("#175CD3").text(pdfDisplayText(`${prefix} - ${source.url}`), { link: source.url, underline: true, lineGap: 2 }).moveDown(0.25);
      } else paragraph(prefix);
    }
  };

  document.addPage();
  document.font("Helvetica-Bold").fontSize(22).fillColor("#0B132B").text(pdfDisplayText(mode === "recruiter" ? "Translucid Recruiter Brief" : "Translucid Investigation Audit"));
  document.font("Helvetica").fontSize(8).fillColor("#65758B").text(pdfDisplayText(`Run ${result.run.id} · ${result.run.runtime} · ${result.run.completedAt}`));
  document.font("Helvetica").fontSize(7).fillColor("#65758B").text(pdfDisplayText(`Input SHA-256 ${result.run.inputSha256}`));

  heading("Investigation summary");
  paragraph(result.summary);
  if (mode === "audit") {
    heading("Status scale");
    for (const status of [2, 1, 0, -1, -2] as const) paragraph(`${status}: ${findingStatusLabels[status]}`);
  }

  let currentSection = "";
  for (const finding of sortedFindings(result)) {
    ensureSpace(mode === "recruiter" ? 120 : 170);
    const section = finding.anchor.kind === "DISCOVERED" ? "Additional independently established findings" : finding.section;
    if (section !== currentSection) {
      currentSection = section;
      heading(section);
    }
    const anchorLabel = finding.anchor.kind === "PDF_TEXT"
      ? `resume p.${finding.anchor.page}, lines ${finding.anchor.lineStart}-${finding.anchor.lineEnd}`
      : "independently discovered finding";
    subheading(`${finding.findingId} · ${finding.status}: ${findingStatusLabels[finding.status]} · ${anchorLabel}`);
    label("Predicate");
    paragraph("predicate" in finding ? finding.predicate : finding.claim);
    label(mode === "audit" ? "Finding / conclusion" : "Conclusion");
    paragraph("conclusion" in finding ? finding.conclusion : finding.evidence);
    label(mode === "recruiter" ? "Why this status" : "Evidence");
    if (mode === "recruiter") {
      paragraph("rationale" in finding ? finding.rationale : finding.evidence);
      if ("remainingGap" in finding && finding.remainingGap) {
        label("Remaining gap");
        paragraph(finding.remainingGap);
      }
    } else {
      if ("evidenceEntries" in finding) {
        for (const entry of finding.evidenceEntries) paragraph(`${entry.relation} - ${entry.comment} [${entry.sourceRef}]`);
      } else paragraph(finding.evidence);
      if ("rationale" in finding) {
        label("Rationale");
        paragraph(finding.rationale);
      }
      if ("remainingGap" in finding && finding.remainingGap) {
        label("Remaining gap");
        paragraph(finding.remainingGap);
      } else if (finding.notes?.trim()) {
        label("Notes");
        paragraph(finding.notes);
      }
    }
    label(mode === "recruiter" ? "Sources (first four)" : "All cited sources");
    sourceList(finding, mode === "recruiter" ? 4 : undefined);
  }
  document.end();
  return completed;
}

export async function renderRecruiterReport(value: LeanReportResult): Promise<Buffer> {
  return render(value, "recruiter");
}

export async function renderAuditReport(value: LeanReportResult): Promise<Buffer> {
  return render(value, "audit");
}

/** Backward-compatible renderer name; the lean API now denotes the complete audit view. */
export async function renderLeanReport(value: LeanReportResult): Promise<Buffer> {
  return renderAuditReport(value);
}

export async function verifyInvestigationReport(bytes: Uint8Array): Promise<{ pageCount: number }> {
  if (Buffer.from(bytes).subarray(0, 5).toString() !== "%PDF-") throw new Error("Report is not a valid PDF: missing PDF signature");
  const loading = getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false });
  try {
    const pdf = await loading.promise;
    if (pdf.numPages < 1) throw new Error("report has no pages");
    await Promise.all(Array.from({ length: pdf.numPages }, async (_, index) => (await pdf.getPage(index + 1)).getTextContent()));
    return { pageCount: pdf.numPages };
  } catch (error) {
    throw new Error(`Report is not a valid PDF: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await loading.destroy();
  }
}
