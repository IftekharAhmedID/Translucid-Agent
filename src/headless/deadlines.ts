export const RUN_TIMEOUT_MS = 30 * 60_000;
export const HOST_FINALIZATION_RESERVE_MS = 120_000;

export function researchDeadlineAt(runDeadlineAt: number): number {
  return runDeadlineAt - HOST_FINALIZATION_RESERVE_MS;
}
