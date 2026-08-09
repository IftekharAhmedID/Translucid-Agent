export type IdentityAnchor = {
  type:
    | "EMPLOYER_OVERLAP"
    | "VERIFIED_DOMAIN"
    | "CROSS_LINKED_ACCOUNT"
    | "LOCATION_HISTORY"
    | "REPOSITORY_IDENTITY"
    | "AUTHORED_PAGE";
  evidenceId: string;
  sourceKey: string;
};

export type EntityLinkAssessment =
  | { allowed: true; confidence: number; reason: "INDEPENDENT_ANCHORS_CONFIRMED" }
  | { allowed: false; confidence: 0; reason: "TWO_INDEPENDENT_ANCHORS_REQUIRED" };

export function assessEntityLink(anchors: IdentityAnchor[]): EntityLinkAssessment {
  const uniqueEvidence = new Set(anchors.map((anchor) => anchor.evidenceId));
  const uniqueSources = new Set(anchors.map((anchor) => anchor.sourceKey));
  const uniqueTypes = new Set(anchors.map((anchor) => anchor.type));

  if (uniqueEvidence.size < 2 || uniqueSources.size < 2 || uniqueTypes.size < 2) {
    return {
      allowed: false,
      confidence: 0,
      reason: "TWO_INDEPENDENT_ANCHORS_REQUIRED",
    };
  }

  return {
    allowed: true,
    confidence: Math.min(0.95, 0.7 + (Math.min(uniqueEvidence.size, 4) - 2) * 0.1),
    reason: "INDEPENDENT_ANCHORS_CONFIRMED",
  };
}
