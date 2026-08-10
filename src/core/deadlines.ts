export const MAX_RESEARCH_PHASE_MS = 7.5 * 60_000;

export function researchPhaseDeadline(now: Date, hardDeadline: Date): Date {
  const availableMs = Math.max(1_000, hardDeadline.getTime() - now.getTime());
  const reviewReserveMs = Math.floor(availableMs / 3);
  const researchMs = Math.min(MAX_RESEARCH_PHASE_MS, availableMs - reviewReserveMs);
  return new Date(now.getTime() + Math.max(1_000, researchMs));
}
