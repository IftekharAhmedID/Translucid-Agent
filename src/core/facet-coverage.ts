import type { ClaimFacet } from "./contracts.ts";

const ignored = new Set([
  "about", "after", "been", "between", "company", "development", "developer", "engineer", "experience",
  "from", "have", "into", "more", "over", "project", "role", "software", "team", "that", "their",
  "there", "these", "this", "through", "with", "work", "the", "and", "at", "for", "of",
]);

const materialSignals = new Set([
  "built", "build", "created", "developed", "designed", " led ", "lead", "managed", "owned", "maintained",
  "supervised", "authored", "presented", "organized", "organised", "contributed", "worked", "joined",
]);

function tokens(value: string): Set<string> {
  return new Set((value.toLocaleLowerCase("en-US").match(/[a-z][a-z0-9+#.-]{2,}|\b[a-z]\d\b|\d[\dA-Za-z+.#-]*\d/g) ?? []).filter((token) => !ignored.has(token)));
}

function splitClauses(value: string): string[] {
  return value
    .split(/;|\n|(?<=[.!?])\s+|\s+(?:and|then)\s+/i)
    .map((clause) => clause.trim().replace(/^[,:-]+|[,:-]+$/g, ""))
    .filter((clause) => clause.length >= 12);
}

function isMaterial(clause: string, clauseTokens: Set<string>): boolean {
  return /\d/.test(clause) || [...materialSignals].some((signal) => clause.toLocaleLowerCase("en-US").includes(signal.trim())) || clauseTokens.size >= 3;
}

export type FacetCoverageIssue = {
  clause: string;
  materiality: "HIGH" | "MEDIUM" | "LOW";
};

export type FacetCoverageAudit = {
  complete: boolean;
  uncovered: FacetCoverageIssue[];
};

export function assertSelfContainedFacetLabels(claimKey: string, facets: Array<{ key: string; label: string }>): void {
  for (const facet of facets) {
    const concreteTokens = tokens(facet.label);
    if (concreteTokens.size < 2) throw new Error(`Facet ${facet.key} on claim ${claimKey} must use a self-contained assertion, not a generic field name.`);
  }
}

export function auditClaimFacetCoverage(normalizedClaim: string, facets: ClaimFacet[]): FacetCoverageAudit {
  const facetTokens = facets.map((facet) => ({ facet, tokens: tokens(facet.label) }));
  const uncovered = splitClauses(normalizedClaim)
    .map((clause) => ({ clause, clauseTokens: tokens(clause) }))
    .filter(({ clause, clauseTokens }) => isMaterial(clause, clauseTokens))
    .filter(({ clauseTokens }) => !facetTokens.some(({ tokens: facetTokenSet }) => {
      const overlap = [...clauseTokens].filter((token) => facetTokenSet.has(token));
      return overlap.length >= 1;
    }))
    .map(({ clause }) => ({ clause, materiality: "MEDIUM" as const }));
  return { complete: uncovered.length === 0, uncovered };
}
