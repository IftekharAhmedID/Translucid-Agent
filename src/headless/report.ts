import PDFDocument from "pdfkit";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { leanReportResultSchema, type LeanReportResult } from "./report-store.ts";

const findingStatusLabels: Record<LeanReportResult["findings"][number]["status"], string> = {
  [-2]: "Directly contradicted by multiple credible sources",
  [-1]: "Materially inconsistent with available evidence",
  [0]: "Unclear or insufficient credible public evidence",
  [1]: "Corroborated with a minor caveat",
  [2]: "Fully corroborated",
};

export async function renderLeanReport(value: LeanReportResult): Promise<Buffer> {
  const result = leanReportResultSchema.parse(value);
  const startedAt = new Date(result.run.startedAt);
  const completedAt = new Date(result.run.completedAt);
  if (!Number.isFinite(startedAt.getTime()) || !Number.isFinite(completedAt.getTime())) throw new Error("Report timestamps are invalid.");
  const document = new PDFDocument({
    autoFirstPage: false,
    size: "LETTER",
    margins: { top: 54, right: 54, bottom: 54, left: 54 },
    info: {
      Title: `Translucid Investigation ${result.run.id}`,
      Author: "Translucid",
      Subject: "Investigator-authored résumé findings",
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
  const heading = (text: string) => document.moveDown(0.8).font("Helvetica-Bold").fontSize(15).fillColor("#14213D").text(text).moveDown(0.35);
  const subheading = (text: string) => document.moveDown(0.25).font("Helvetica-Bold").fontSize(10.5).fillColor("#14213D").text(text).moveDown(0.15);
  const label = (text: string) => document.font("Helvetica-Bold").fontSize(8.8).fillColor("#65758B").text(text).moveDown(0.1);
  const paragraph = (text: string) => document.font("Helvetica").fontSize(9.3).fillColor("#273449").text(text || "Not available", { lineGap: 2 }).moveDown(0.4);

  document.addPage();
  document.font("Helvetica-Bold").fontSize(22).fillColor("#0B132B").text("Translucid Investigation Report");
  document.font("Helvetica").fontSize(8).fillColor("#65758B").text(`Run ${result.run.id} · ${result.run.runtime} · ${result.run.completedAt}`);
  document.font("Helvetica").fontSize(7).fillColor("#65758B").text(`Input SHA-256 ${result.run.inputSha256}`);

  heading("Investigation summary");
  paragraph(result.summary);
  heading("Status scale");
  for (const status of [2, 1, 0, -1, -2] as const) paragraph(`${status}: ${findingStatusLabels[status]}`);

  const findings = [...result.findings].sort((left, right) => left.anchor.page - right.anchor.page
    || left.anchor.lineStart - right.anchor.lineStart
    || left.order - right.order);
  let currentSection = "";
  for (const finding of findings) {
    ensureSpace(150);
    if (finding.section !== currentSection) {
      currentSection = finding.section;
      heading(currentSection);
    }
    subheading(`${finding.findingId} · ${finding.status}: ${findingStatusLabels[finding.status]} · résumé p.${finding.anchor.page}, lines ${finding.anchor.lineStart}–${finding.anchor.lineEnd}`);
    label("Claim");
    paragraph(finding.claim);
    label("Evidence");
    paragraph(finding.evidence);
    if (finding.notes?.trim()) {
      label("Notes");
      paragraph(finding.notes);
    }
    label("Sources");
    if (!finding.sources.length) paragraph("No captured source cited.");
    for (const [index, source] of finding.sources.entries()) {
      const prefix = `(${index + 1}) ${source.title ?? source.sourceRef}`;
      if (source.url) {
        document.font("Helvetica").fontSize(8.8).fillColor("#175CD3").text(`${prefix} — ${source.url}`, { link: source.url, underline: true, lineGap: 2 }).moveDown(0.25);
      } else paragraph(`${prefix} — ${source.sourceRef}`);
    }
  }
  document.end();
  return completed;
}

export async function verifyInvestigationReport(bytes: Uint8Array): Promise<void> {
  if (Buffer.from(bytes).subarray(0, 5).toString() !== "%PDF-") throw new Error("Report is not a valid PDF: missing PDF signature");
  const loading = getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false });
  try {
    const pdf = await loading.promise;
    if (pdf.numPages < 1) throw new Error("report has no pages");
    await Promise.all(Array.from({ length: pdf.numPages }, async (_, index) => (await pdf.getPage(index + 1)).getTextContent()));
  } catch (error) {
    throw new Error(`Report is not a valid PDF: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await loading.destroy();
  }
}
