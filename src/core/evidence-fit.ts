import type { ClaimFacet } from "./contracts.ts";

const ignored = new Set([
  "about", "after", "and", "are", "been", "between", "but", "can", "company", "development", "developer", "engineer", "experience", "for", "from", "had", "has", "have", "her", "his", "into", "its", "more", "not", "of", "over", "project", "role", "software", "team", "that", "the", "their", "there", "these", "this", "through", "was", "were", "while", "with", "work", "who",
]);

const actionFamilies = [
  ["work", "worked", "works", "employment", "employed", "joined", "served"],
  ["build", "built", "developed", "implemented", "created", "authored", "maintained"],
  ["lead", "led", "owned", "managed", "directed"],
  ["study", "studied", "degree", "graduated", "education"],
  ["speak", "spoke", "presented", "conference", "event"],
];
const adjacentWork = /\b(?:commit|pull request|patch|jit|optimization)\b/i;
const statusProofs: Array<[RegExp, RegExp]> = [
  [/\b(?:core developer|core team)\b/i, /\b(?:core developer|core team|core member)\b/i],
  [/\b(?:employed|employment|works? at|worked at|tenure)\b/i, /\b(?:employed|employment|works? at|worked at|joined|tenure)\b/i],
  [/\b(?:title|held the title)\b/i, /\b(?:title|engineer|developer|manager|director)\b/i],
  [/(?:organiz\w+.*europython|europython.*organiz\w+)/i, /(?:organiz\w+.*europython|europython.*organiz\w+)/i],
  [/(?:python guild.*(?:lead|led|member)|(?:lead|led|member).*python guild)/i, /(?:python guild.*(?:lead|led|member)|(?:lead|led|member).*python guild)/i],
];

type Token = { value: string; source: string; index: number };

function tokenise(value: string): Token[] {
  const matches = value.match(/[A-Za-z][A-Za-z0-9+.#-]*[A-Za-z0-9+#-]|\d[\dA-Za-z+.#-]*\d/g) ?? [];
  return matches
    .filter((source) => source.length >= 3)
    .flatMap((source, index) => [source, ...source.split(/[+.#-]/).filter((part) => part.length >= 3)].map((part, partIndex) => ({ value: part.toLocaleLowerCase("en-US"), source: part, index: index + partIndex })));
}

function meaningfulTokens(value: string): Token[] {
  return tokenise(value).filter(({ value }) => !ignored.has(value));
}

function normalizedPhrase(tokens: Token[]): string {
  return tokens.map(({ value }) => value).join(" ");
}

function hasActionOverlap(claimTokens: Token[], quoteTokens: Token[]): boolean {
  const claimActions = actionFamilies.filter((family) => family.some((action) => claimTokens.some(({ value }) => value === action)));
  if (claimActions.length === 0) return true;
  const quoteHasAction = actionFamilies.some((family) => family.some((action) => quoteTokens.some(({ value }) => value === action)));
  return !quoteHasAction || claimActions.some((family) => family.some((action) => quoteTokens.some(({ value }) => value === action)));
}

function hasNumericOrAcronymAnchor(claimTokens: Token[], quoteTokens: Token[]): boolean {
  const claimAnchors = claimTokens.filter(({ source }) => /\d/.test(source) || /^[A-Z]{2,}(?:\d+)?$/.test(source));
  return claimAnchors.some(({ value }) => quoteTokens.some((token) => token.value === value));
}

export function facetEvidenceCompatible(exactQuote: string, facetLabel: string): boolean {
  if (adjacentWork.test(exactQuote) && statusProofs.some(([claim, proof]) => claim.test(facetLabel) && !proof.test(exactQuote))) return false;
  const compatibility = evaluateEvidenceCompatibility(exactQuote, facetLabel);
  if (compatibility.compatible) return true;
  return compatibility.sharedAnchors.length === 1 && compatibility.sharedAnchors[0]!.length >= 4;
}

export type EvidenceCompatibility = {
  compatible: boolean;
  reason: string;
  sharedAnchors: string[];
};

/**
 * Conservative lexical gate only. It rejects obvious mismatches before a
 * semantic critic sees an edge; it is deliberately not an entailment model.
 */
export function evaluateEvidenceCompatibility(exactQuote: string, normalizedClaim: string): EvidenceCompatibility {
  const claimTokens = meaningfulTokens(normalizedClaim);
  const quoteTokens = meaningfulTokens(exactQuote);
  const quoteSet = new Set(quoteTokens.map(({ value }) => value));
  const sharedAnchors = [...new Set(claimTokens.filter(({ value }) => quoteSet.has(value)).map(({ value }) => value))];
  if (claimTokens.length === 0 || quoteTokens.length === 0) return { compatible: false, reason: "No meaningful lexical anchors were available.", sharedAnchors };
  if (!hasActionOverlap(claimTokens, quoteTokens)) return { compatible: false, reason: "The evidence predicate does not match the claim predicate.", sharedAnchors };
  if (sharedAnchors.length >= 2) return { compatible: true, reason: "Two or more non-generic claim anchors overlap.", sharedAnchors };
  if (hasNumericOrAcronymAnchor(claimTokens, quoteTokens)) return { compatible: true, reason: "A date, number, or acronym anchor overlaps.", sharedAnchors };
  const claimPhrase = normalizedPhrase(claimTokens);
  const quotePhrase = normalizedPhrase(quoteTokens);
  if (claimPhrase.length >= 12 && (quotePhrase.includes(claimPhrase) || claimPhrase.includes(quotePhrase))) return { compatible: true, reason: "A distinctive phrase overlaps.", sharedAnchors };
  return { compatible: false, reason: "Only generic or insufficient anchors overlap.", sharedAnchors };
}

export function evidenceQuoteHasClaimAnchor(exactQuote: string, normalizedClaim: string): boolean {
  return evaluateEvidenceCompatibility(exactQuote, normalizedClaim).compatible;
}

export type AuditableEvidence = {
  id: string;
  relation: "SUPPORTS" | "CONTRADICTS" | "CONTEXT";
  claimIds: string[];
  facetKeys?: string[];
  exactQuote: string;
};

export type AuditableClaim = { id: string; normalizedClaim: string; facets?: ClaimFacet[] };

export type RejectedEvidenceEdge = {
  evidenceId: string;
  reason: string;
  claimIds: string[];
};

export function auditEvidenceEdges(evidence: AuditableEvidence[], claims: AuditableClaim[]): {
  accepted: AuditableEvidence[];
  rejected: RejectedEvidenceEdge[];
} {
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const accepted: AuditableEvidence[] = [];
  const rejected: RejectedEvidenceEdge[] = [];
  for (const edge of evidence) {
    const claimIds = [...new Set(edge.claimIds)];
    const invalidClaim = claimIds.find((claimId) => !claimById.has(claimId));
    if (invalidClaim) {
      rejected.push({ evidenceId: edge.id, claimIds, reason: `Evidence references unknown claim ${invalidClaim}.` });
      continue;
    }
    if (edge.relation !== "CONTEXT" && claimIds.length !== 1) {
      rejected.push({ evidenceId: edge.id, claimIds, reason: `${edge.relation} evidence must reference exactly one claim.` });
      continue;
    }
    if (edge.relation === "CONTEXT") {
      accepted.push({ ...edge, claimIds });
      continue;
    }
    const claim = claimById.get(claimIds[0]!);
    const facetKeys = [...new Set(edge.facetKeys ?? [])];
    if (facetKeys.length === 0) {
      rejected.push({ evidenceId: edge.id, claimIds, reason: `${edge.relation} evidence has no declared facet keys.` });
      continue;
    }
    if (claim?.facets?.length) {
      const declared = new Set(claim.facets.map(({ key }) => key));
      const unknownFacet = facetKeys.find((key) => !declared.has(key));
      if (unknownFacet) {
        rejected.push({ evidenceId: edge.id, claimIds, reason: `Evidence references unknown facet ${unknownFacet} on claim ${claim.id}.` });
        continue;
      }
      const incompatibleFacet = facetKeys.find((key) => {
        const facet = claim.facets?.find(({ key: facetKey }) => facetKey === key);
        return facet ? !facetEvidenceCompatible(edge.exactQuote, facet.label) : true;
      });
      if (incompatibleFacet) {
        rejected.push({ evidenceId: edge.id, claimIds, reason: `Evidence quote is incompatible with facet ${incompatibleFacet}.` });
        continue;
      }
    }
    const compatibility = evaluateEvidenceCompatibility(edge.exactQuote, claim!.normalizedClaim);
    if (!compatibility.compatible) {
      rejected.push({ evidenceId: edge.id, claimIds, reason: compatibility.reason });
      continue;
    }
    accepted.push({ ...edge, claimIds });
  }
  return { accepted, rejected };
}
