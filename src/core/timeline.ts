import { compareTemporalObservations, type TemporalObservation } from "./temporal.ts";

export const timelineStates = ["REPORTED", "SUPPORTED_SELF", "CORROBORATED", "CONFLICTING"] as const;
export type TimelineState = (typeof timelineStates)[number];

export type TimelineObservation = TemporalObservation & {
  id: string;
  artifactId: string;
};

export type TimelineEvidence = {
  artifactId: string;
  relation: "SUPPORTS" | "CONTRADICTS" | "CONTEXT";
  sourceAuthority?: string | null;
  attestationGroup?: string | null;
};

function sameValue(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(left) === JSON.stringify(right); }
  catch { return String(left) === String(right); }
}

export function deriveTimelineStates<T extends TimelineObservation>(observations: T[], evidence: TimelineEvidence[]): Array<T & { timelineState: TimelineState }> {
  return observations.map((observation) => {
    const peers = observations.filter((peer) => peer.id !== observation.id && peer.field === observation.field && !sameValue(peer.value, observation.value));
    const hasTemporalConflict = peers.some((peer) => {
      const comparison = compareTemporalObservations(observation, peer);
      return comparison === "SAME_TIME" || comparison === "OVERLAPPING";
    });
    const artifactEvidence = evidence.filter((edge) => edge.artifactId === observation.artifactId);
    const hasContradiction = artifactEvidence.some((edge) => edge.relation === "CONTRADICTS");
    const hasIndependentSupport = artifactEvidence.some((edge) => edge.relation === "SUPPORTS" && edge.sourceAuthority && edge.sourceAuthority !== "CONTEXT" && edge.sourceAuthority !== "SELF_REPRESENTATION" && edge.sourceAuthority !== "DISCOVERY_ONLY" && edge.attestationGroup !== "CANDIDATE_SELF");
    const hasSelfSupport = artifactEvidence.some((edge) => edge.relation === "SUPPORTS" && edge.sourceAuthority === "SELF_REPRESENTATION");
    const timelineState: TimelineState = hasTemporalConflict || hasContradiction ? "CONFLICTING" : hasIndependentSupport ? "CORROBORATED" : hasSelfSupport ? "SUPPORTED_SELF" : "REPORTED";
    return { ...observation, timelineState };
  });
}
