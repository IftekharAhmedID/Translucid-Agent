import PDFDocument from "pdfkit";

import { getInvestigationDetail } from "../db/read-model.ts";

type Row = Record<string, unknown>;

function text(value: unknown): string { return typeof value === "string" ? value : value === null || value === undefined ? "" : JSON.stringify(value); }
function date(value: unknown): string { return value instanceof Date ? value.toISOString() : typeof value === "string" ? new Date(value).toISOString() : "Not recorded"; }

export async function generateInvestigationReport(investigationId: string): Promise<Buffer | undefined> {
  const detail = await getInvestigationDetail(investigationId);
  if (!detail) return undefined;
  const createdAt = detail.createdAt instanceof Date ? detail.createdAt : new Date(String(detail.createdAt));
  const document = new PDFDocument({
    autoFirstPage: false,
    size: "LETTER",
    margins: { top: 54, right: 54, bottom: 54, left: 54 },
    info: { Title: `Translucid Investigation ${investigationId}`, Author: "Translucid", Creator: "Translucid deterministic report", CreationDate: createdAt, ModDate: createdAt },
  });
  const chunks: Buffer[] = [];
  document.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const completed = new Promise<Buffer>((resolve, reject) => {
    document.once("end", () => resolve(Buffer.concat(chunks)));
    document.once("error", reject);
  });
  const heading = (title: string) => { document.moveDown(0.8).font("Helvetica-Bold").fontSize(15).fillColor("#14213D").text(title).moveDown(0.35); };
  const paragraph = (value: unknown) => document.font("Helvetica").fontSize(9.5).fillColor("#273449").text(text(value) || "Not available", { lineGap: 2 }).moveDown(0.45);
  const bullet = (value: unknown) => document.font("Helvetica").fontSize(9).fillColor("#273449").text(`• ${text(value)}`, { indent: 10, lineGap: 2 }).moveDown(0.2);

  document.addPage();
  document.font("Helvetica-Bold").fontSize(23).fillColor("#0B132B").text("Translucid Investigation Report");
  document.font("Helvetica").fontSize(8).fillColor("#65758B").text(`Case ${investigationId}  •  ${text(detail.status)}  •  created ${date(detail.createdAt)}`);
  document.moveDown(1);
  const summary = detail.finalSummary as Row | undefined;
  heading("Investigation summary");
  if (summary) {
    const identity = summary.professionalIdentity as Row;
    paragraph(`${text(identity.status)} — ${text(identity.summary)}`);
    paragraph(summary.professionalTimelineSummary);
    const timelineEvidenceIds = summary.professionalTimelineEvidenceIds as string[];
    if (timelineEvidenceIds?.length) paragraph(`Timeline evidence: ${timelineEvidenceIds.join(", ")}`);
    const inconsistencies = summary.materialInconsistencies as Row[];
    if (inconsistencies?.length) { document.font("Helvetica-Bold").fontSize(10).text("Material inconsistencies"); inconsistencies.forEach((item) => bullet(item.summary)); }
    const unresolved = summary.unresolvedMaterialClaimIds as string[];
    if (unresolved?.length) { document.font("Helvetica-Bold").fontSize(10).text("Unresolved material claims"); unresolved.forEach(bullet); }
    const limitations = summary.investigationLimitations as string[];
    if (limitations?.length) { document.font("Helvetica-Bold").fontSize(10).text("Limitations"); limitations.forEach(bullet); }
  } else paragraph("Final adjudication is not available. Captured state appears in the following sections.");

  heading("Claim-level findings");
  const claimById = new Map((detail.claims as Row[]).map((claim) => [String(claim.id), claim]));
  const findings = detail.findings as Row[];
  if (!findings.length) paragraph("No findings have been saved.");
  for (const finding of findings) {
    const claim = claimById.get(String(finding.claimId));
    document.font("Helvetica-Bold").fontSize(10).fillColor("#14213D").text(`${text(finding.verdict)} · ${text(finding.strength)}`);
    paragraph(claim?.normalizedClaim ?? finding.claimId);
    paragraph(finding.explanation);
    const limitations = finding.limitations as string[];
    limitations?.forEach((item) => bullet(`Limitation: ${item}`));
  }

  heading("Professional timeline");
  const observations = detail.observations as Row[];
  if (!observations.length) paragraph("No normalized observations were recorded.");
  for (const observation of observations) bullet(`${date(observation.validFrom)} to ${date(observation.validTo)} — ${text(observation.field)}: ${text(observation.value)} [artifact ${text(observation.artifactId)}]`);

  heading("Identity resolution");
  const entities = detail.entities as Row[];
  const links = detail.links as Row[];
  entities.forEach((entity) => bullet(`${text(entity.type)} — ${text(entity.canonicalName)} (${text(entity.id)})`));
  links.forEach((link) => bullet(`${text(link.fromEntityId)} → ${text(link.toEntityId)} · ${text(link.relationship)} · confidence ${text(link.confidence)} · evidence ${text(link.evidenceIds)}`));

  document.addPage();
  heading("Evidence endnotes");
  const artifacts = new Map((detail.artifacts as Row[]).map((artifact) => [String(artifact.id), artifact]));
  const evidence = detail.evidence as Row[];
  if (!evidence.length) paragraph("No evidence was captured.");
  for (const item of evidence) {
    const artifact = artifacts.get(String(item.artifactId));
    document.font("Helvetica-Bold").fontSize(9).fillColor("#14213D").text(`${text(item.id)} · ${text(item.relation)} · ${text(item.sourceTier)}`);
    paragraph(`“${text(item.exactQuote)}”`);
    paragraph(`${text(artifact?.sourceUrl) || "Local input"} · retrieved ${date(artifact?.retrievedAt)} · SHA-256 ${text(artifact?.sha256)}`);
  }
  document.end();
  return completed;
}
