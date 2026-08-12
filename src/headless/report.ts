import PDFDocument from "pdfkit";

import type { InvestigationResult } from "./result-contract.ts";

function numericId(value: string): number {
  return Number(value.replace(/^\D+/, ""));
}

function displayStrength(value: InvestigationResult["claims"][number]["strength"]): string {
  return value ?? "—";
}

export async function renderInvestigationReport(result: InvestigationResult): Promise<Buffer> {
  const recordedStart = new Date(result.run.startedAt);
  if (!Number.isFinite(recordedStart.getTime())) throw new Error("Run start time is invalid.");
  const document = new PDFDocument({
    autoFirstPage: false,
    size: "LETTER",
    margins: { top: 54, right: 54, bottom: 54, left: 54 },
    info: {
      Title: `Translucid Investigation ${result.run.id}`,
      Author: "Translucid",
      Subject: "Evidence-correct professional investigation",
      Creator: "Translucid deterministic report",
      Producer: "Translucid deterministic report",
      CreationDate: recordedStart,
      ModDate: recordedStart,
    },
  });
  const chunks: Buffer[] = [];
  document.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const completed = new Promise<Buffer>((resolve, reject) => {
    document.once("end", () => resolve(Buffer.concat(chunks)));
    document.once("error", reject);
  });
  const heading = (title: string) => document.moveDown(0.75).font("Helvetica-Bold").fontSize(15).fillColor("#14213D").text(title).moveDown(0.3);
  const subheading = (title: string) => document.moveDown(0.3).font("Helvetica-Bold").fontSize(10.5).fillColor("#14213D").text(title).moveDown(0.15);
  const paragraph = (value: string) => document.font("Helvetica").fontSize(9.3).fillColor("#273449").text(value || "Not available", { lineGap: 2 }).moveDown(0.4);
  const bullet = (value: string) => document.font("Helvetica").fontSize(8.8).fillColor("#273449").text(`• ${value}`, { indent: 10, lineGap: 2 }).moveDown(0.18);

  document.addPage();
  document.font("Helvetica-Bold").fontSize(22).fillColor("#0B132B").text("Translucid Investigation Report");
  document.font("Helvetica").fontSize(8).fillColor("#65758B").text(`Run ${result.run.id} · ${result.run.status} · ${result.run.runtime} · ${result.run.startedAt}`);

  heading("Investigation summary");
  paragraph(`${result.summary.professionalIdentity.status} — ${result.summary.professionalIdentity.text}`);
  paragraph(result.summary.professionalTimelineSummary);
  if (result.summary.materialInconsistencies.length) {
    subheading("Material inconsistencies");
    for (const item of result.summary.materialInconsistencies) bullet(`${item.claimId}: ${item.text} [${item.evidenceIds.join(", ")}]`);
  }
  if (result.summary.limitations.length) {
    subheading("Limitations");
    for (const limitation of result.summary.limitations) bullet(limitation);
  }

  heading("Deterministic audit");
  const stats = result.audit.statistics;
  paragraph(`Audit ${result.audit.status}. Compiler attempts ${result.audit.compilerAttempts}; auditor attempts ${result.audit.auditorAttempts}. Claims ${stats.claims}; facets ${stats.facets}; evidence ${stats.evidence}; sources ${stats.sources}; rejected citations ${stats.rejectedCitations}; provider calls ${stats.providerCalls}; cache hits ${stats.cacheHits}.`);
  for (const [authority, count] of Object.entries(stats.sourceAuthorityCounts).sort(([left], [right]) => left.localeCompare(right))) bullet(`${authority}: ${count}`);
  for (const warning of result.audit.warnings) bullet(`Warning: ${warning}`);

  heading("Claim-level findings");
  const claims = [...result.claims].sort((left, right) => numericId(left.id) - numericId(right.id));
  for (const claim of claims) {
    subheading(`${claim.id} · ${claim.verdict} · ${displayStrength(claim.strength)}`);
    paragraph(claim.statement);
    paragraph(claim.explanation);
    for (const facet of claim.facets) bullet(`${facet.status} · ${displayStrength(facet.strength)} · ${facet.label} — ${facet.note} [evidence: ${facet.evidenceIds.join(", ") || "none"}]`);
  }

  heading("Professional timeline");
  if (!result.timeline.length) paragraph("No timeline entries were compiled.");
  for (const item of result.timeline) bullet(`${item.validFrom ?? "undated"} to ${item.validTo ?? "open"} · ${item.state} · ${item.label} [claims: ${item.claimIds.join(", ")}; evidence: ${item.evidenceIds.join(", ") || "none"}]`);

  document.addPage();
  heading("Evidence endnotes");
  const sourceByRef = new Map(result.sources.map((source) => [source.ref, source]));
  const evidence = [...result.evidence].sort((left, right) => numericId(left.id) - numericId(right.id));
  if (!evidence.length) paragraph("No citation-eligible evidence was compiled.");
  for (const item of evidence) {
    const source = sourceByRef.get(item.sourceRef);
    subheading(`${item.id} · ${item.relation} · ${item.claimId} · facets ${item.facetKeys.join(", ")}`);
    paragraph(`“${item.exactQuote}”`);
    paragraph(`${item.sourceRef} · ${source?.url ?? "No public URL"} · ${item.sourceAuthority} · retrieved ${source?.retrievedAt ?? "not recorded"} · SHA-256 ${source?.sha256 ?? "not recorded"}`);
  }

  heading("Source manifest");
  for (const source of [...result.sources].sort((left, right) => numericId(left.ref) - numericId(right.ref))) {
    bullet(`${source.ref} · ${source.title ?? source.url ?? source.kind} · ${source.providerRoute} · ${source.sourceAuthority} · ${source.sha256} · ${source.relativePath}`);
  }
  document.end();
  return completed;
}
