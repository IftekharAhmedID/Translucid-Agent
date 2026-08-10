export function forcedFinalizationAt(
  hardDeadline: Date,
  finalizationReserveMs: number,
  caseStartedAt = new Date(hardDeadline.getTime() - 60 * 60_000),
): Date {
  const caseEnvelopeMs = hardDeadline.getTime() - caseStartedAt.getTime();
  if (!Number.isFinite(finalizationReserveMs) || finalizationReserveMs <= 0 || finalizationReserveMs >= caseEnvelopeMs) {
    throw new Error("Finalization reserve must be positive and smaller than the case deadline envelope.");
  }
  return new Date(hardDeadline.getTime() - finalizationReserveMs);
}
