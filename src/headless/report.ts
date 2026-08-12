import PDFDocument from "pdfkit";

import type { InvestigationResult } from "./result-contract.ts";

function numericId(value: string): number {
  return Number(value.replace(/^\D+/, ""));
}

function displayStrength(value: InvestigationResult["claims"][number]["strength"]): string {
  return value ?? "—";
}

function counts(result: InvestigationResult): string {
  const verdicts = new Map<string, number>();
  const materiality = new Map<string, number>();
  const strengths = new Map<string, number>();
  for (const claim of result.claims) {
    verdicts.set(claim.verdict, (verdicts.get(claim.verdict) ?? 0) + 1);
    materiality.set(claim.materiality, (materiality.get(claim.materiality) ?? 0) + 1);
    strengths.set(claim.strength ?? "UNRESOLVED", (strengths.get(claim.strength ?? "UNRESOLVED") ?? 0) + 1);
  }
  const format = (values: Map<string, number>) => [...values.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key} ${value}`).join(", ");
  return `Claims by verdict: ${format(verdicts)}. Materiality: ${format(materiality)}. Strength: ${format(strengths)}.`;
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
      Subject: "Exhaustive evidence investigation",
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
  const subheading = (title: string, options?: { link?: string; destination?: string }) => {
    document.moveDown(0.3).font("Helvetica-Bold").fontSize(10.5).fillColor("#14213D").text(title, options?.link ? { link: options.link } : options?.destination ? { goTo: options.destination } : undefined).moveDown(0.15);
  };
  const paragraph = (value: string) => document.font("Helvetica").fontSize(9.3).fillColor("#273449").text(value || "Not available", { lineGap: 2 }).moveDown(0.4);
  const bullet = (value: string, options?: { link?: string; destination?: string }) => document.font("Helvetica").fontSize(8.8).fillColor("#273449").text(`• ${value}`, { indent: 10, lineGap: 2, ...(options?.link ? { link: options.link } : {}), ...(options?.destination ? { goTo: options.destination } : {}) }).moveDown(0.18);
  const sourceByRef = new Map(result.sources.map((source) => [source.ref, source]));
  const citedRefs = new Set(result.evidence.map((evidence) => evidence.sourceRef));
  const citedSources = [...result.sources].filter((source) => citedRefs.has(source.ref)).sort((left, right) => numericId(left.ref) - numericId(right.ref));
  const evidenceByClaim = new Map<string, InvestigationResult["evidence"]>();
  for (const evidence of result.evidence) evidenceByClaim.set(evidence.claimId, [...(evidenceByClaim.get(evidence.claimId) ?? []), evidence]);

  document.addPage();
  document.font("Helvetica-Bold").fontSize(22).fillColor("#0B132B").text("Translucid Investigation Report");
  document.font("Helvetica").fontSize(8).fillColor("#65758B").text(`Run ${result.run.id} · ${result.run.status} · ${result.run.runtime} · ${result.run.startedAt}`);
  paragraph(`Scope: every substantive factual résumé assertion represented in the parsed input. Contact fields, headings, personality adjectives, and bare skill keywords are not claims. Unresolved claims are not treated as false.`);

  heading("Coverage and executive overview");
  paragraph(`Identity resolution (identity metadata only): ${result.summary.professionalIdentity.status} — ${result.summary.professionalIdentity.text}`);
  paragraph(`Deterministic claim rollup: ${counts(result)}`);
  paragraph(result.summary.professionalTimelineSummary);
  if (result.summary.strongestEvidenceByClaim.length) {
    subheading("Strongest evidence");
    for (const item of result.summary.strongestEvidenceByClaim) bullet(`${item.claimId}: facets ${item.facetKeys.join(", ")} · evidence ${item.evidenceIds.join(", ")}`, { destination: `claim-${item.claimId}` });
  }
  if (result.summary.materialInconsistencies.length) {
    subheading("Material inconsistencies");
    for (const item of result.summary.materialInconsistencies) bullet(`${item.claimId}: ${item.text} [${item.evidenceIds.join(", ")}]`, { destination: `claim-${item.claimId}` });
  }
  if (result.summary.limitations.length) {
    subheading("Investigation limitations");
    for (const limitation of result.summary.limitations) bullet(limitation);
  }
  subheading("Research and audit statistics");
  const stats = result.audit.statistics;
  paragraph(`Audit ${result.audit.status}. Compiler attempts ${result.audit.compilerAttempts}; auditor attempts ${result.audit.auditorAttempts}. Claims ${stats.claims}; facets ${stats.facets}; evidence ${stats.evidence}; cited sources ${citedSources.length}; preserved-source records ${stats.sources}; rejected citations ${stats.rejectedCitations}; provider calls ${stats.providerCalls}; cache hits ${stats.cacheHits}.`);
  for (const [authority, countValue] of Object.entries(stats.sourceAuthorityCounts).sort(([left], [right]) => left.localeCompare(right))) bullet(`${authority}: ${countValue}`);
  for (const warning of result.audit.warnings) bullet(`Warning: ${warning}`);

  heading("Claim index");
  const claims = [...result.claims].sort((left, right) => numericId(left.id) - numericId(right.id));
  for (const claim of claims) bullet(`${claim.id} · page ${claim.sourceSpan.page ?? "—"} · ${claim.category} · ${claim.materiality} · ${claim.verdict} · ${displayStrength(claim.strength)} · ${claim.statement}`, { destination: `claim-${claim.id}` });

  heading("Complete claim findings");
  for (const claim of claims) {
    document.addNamedDestination(`claim-${claim.id}`);
    subheading(`${claim.id} · ${claim.verdict} · ${displayStrength(claim.strength)}`);
    paragraph(`Résumé source span${claim.sourceSpan.page ? ` (page ${claim.sourceSpan.page})` : ""}: ${claim.sourceSpan.text}`);
    paragraph(`Normalized claim: ${claim.statement}`);
    paragraph(`Conclusion: ${claim.explanation}`);
    for (const facet of claim.facets) {
      bullet(`${facet.key} · ${facet.materiality} · ${facet.status} · ${displayStrength(facet.strength)} · ${facet.label} — ${facet.note} [evidence: ${facet.evidenceIds.join(", ") || "none"}]`);
    }
    const claimEvidence = [...(evidenceByClaim.get(claim.id) ?? [])].sort((left, right) => numericId(left.id) - numericId(right.id));
    if (!claimEvidence.length) paragraph("Unresolved: no citation-eligible evidence was preserved for this claim.");
    for (const evidence of claimEvidence) {
      const source = sourceByRef.get(evidence.sourceRef);
      subheading(`${evidence.id} · ${evidence.relation} · ${evidence.sourceRef} · facets ${evidence.facetKeys.join(", ")}`);
      paragraph(`Exact quote: “${evidence.exactQuote}”`);
      paragraph(`Location: ${JSON.stringify(evidence.sourceLocation)} · Authority: ${evidence.sourceAuthority} · Retrieved: ${source?.retrievedAt ?? "not recorded"} · SHA-256: ${source?.sha256 ?? "not recorded"}`);
      if (source?.url) paragraph(`Public source: ${source.url}`);
      if (source?.url) document.text(source.url, { link: source.url, underline: true, continued: false }).moveDown(0.35);
    }
  }

  heading("Professional timeline");
  if (!result.timeline.length) paragraph("No timeline entries were compiled.");
  for (const item of result.timeline) bullet(`${item.validFrom ?? "undated"} to ${item.validTo ?? "open"} · ${item.state} · ${item.label} [claims: ${item.claimIds.join(", ")}; evidence: ${item.evidenceIds.join(", ") || "none"}]`, { destination: item.claimIds[0] ? `claim-${item.claimIds[0]}` : undefined });

  document.addPage();
  heading("Cited source registry");
  paragraph("Only sources used by at least one evidence item appear here. The immutable source store may retain additional uncited discovery and context responses.");
  for (const source of citedSources) {
    subheading(`${source.ref} · ${source.title ?? source.url ?? source.kind}`);
    paragraph(`${source.sourceAuthority} · ${source.providerRoute} · retrieved ${source.retrievedAt} · SHA-256 ${source.sha256} · ${source.relativePath}`);
    if (source.url) document.text(source.url, { link: source.url, underline: true }).moveDown(0.35);
  }
  document.end();
  return completed;
}
