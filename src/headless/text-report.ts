type Finding = {
  status: number;
  anchor: { kind: string };
  section?: string;
  claim?: string;
  conclusion?: string;
  evidence?: string;
  remainingGap?: string | null;
  rationale?: string;
  evidenceEntries?: Array<{ sourceRef: string; relation: string; comment: string }>;
  sources?: Array<{ sourceRef: string; title?: string; url?: string }>;
};

export function evidenceScore(findings: Finding[]) {
  const submitted = findings.filter((finding) => finding.anchor.kind === "PDF_TEXT");
  const count = (status: number) => submitted.filter((finding) => finding.status === status).length;
  return {
    score: submitted.length ? Math.round((count(2) + count(1) * 0.5) / submitted.length * 100) : null,
    claims: submitted.length, established: count(2), partial: count(1), unresolved: count(0), conflicting: count(-1), contradicted: count(-2),
  };
}

export function renderTextReport(result: { summary: string; findings: Finding[] }): string {
  const score = evidenceScore(result.findings);
  const statuses: Record<number, string> = { 2: "Established", 1: "Partial", 0: "Unresolved", [-1]: "Conflicting", [-2]: "Contradicted" };
  return [
    "TraceDog investigation report", "",
    `TraceDog evidence-support score: ${score.score === null ? "Not available" : `${score.score}/100`}`,
    `Submitted claims reviewed: ${score.claims}. Established: ${score.established}; partial: ${score.partial}; unresolved: ${score.unresolved}; conflicting: ${score.conflicting}; contradicted: ${score.contradicted}.`,
    "The score measures captured support for reviewed claims, not a probability of truth or a person's trustworthiness. Established claims count 100, partial claims 50, all other statuses 0. Discovered facts do not affect it. Claim selection can affect the score. Human review is required.",
    "", result.summary, "",
    ...result.findings.flatMap((finding, index) => [
      `${index + 1}. ${finding.section ?? "Finding"} — ${statuses[finding.status] ?? "Unresolved"}`,
      finding.claim ?? "", finding.conclusion ?? "",
      ...(finding.rationale ? [`Basis: ${finding.rationale}`] : []),
      ...(finding.evidenceEntries?.length ? finding.evidenceEntries.map((entry) => `Evidence ${entry.sourceRef} (${entry.relation}): ${entry.comment}`) : finding.evidence ? [finding.evidence] : []),
      ...(finding.remainingGap ? [`Remaining gap: ${finding.remainingGap}`] : []),
      ...(finding.sources ?? []).map((source) => `Source ${source.sourceRef}: ${source.title ?? "Captured source"}${source.url ? ` — ${source.url}` : ""}`), "",
    ]),
  ].join("\n");
}
