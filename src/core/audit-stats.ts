export type AuditStats = {
  totalClaims: number;
  totalEvidenceRows: number;
  selectedEvidenceRows: number;
  researchQuestionCount: number;
  criticPacketCount: number;
  claimsProcessed: number;
  extractionTruncated: boolean;
  evidenceEdgesRejected: number;
  sourceAuthorityCounts: Record<string, number>;
  capabilityLimitations: string[];
};

export function countSourceAuthorities(values: Array<{ sourceAuthority?: string | null; sourceTier?: string | null }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const authority = value.sourceAuthority ?? value.sourceTier ?? "CONTEXT";
    counts[authority] = (counts[authority] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}
