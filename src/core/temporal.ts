export type TemporalComparison = "SAME_TIME" | "OVERLAPPING" | "PROGRESSION" | "UNKNOWN";

export type TemporalObservation = {
  field: string;
  value?: unknown;
  sourceEventAt?: Date | string | null;
  validFrom?: Date | string | null;
  validTo?: Date | string | null;
};

function timestamp(value: Date | string | null | undefined): number | undefined {
  if (!value) return undefined;
  const result = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(result) ? result : undefined;
}

function interval(observation: TemporalObservation): { start?: number; end?: number; point?: number } {
  const point = timestamp(observation.sourceEventAt);
  const start = timestamp(observation.validFrom) ?? point;
  const end = timestamp(observation.validTo) ?? point;
  return { start, end, point };
}

/** Compare temporal placement only; semantic value conflict is adjudicated separately. */
export function compareTemporalObservations(a: TemporalObservation, b: TemporalObservation): TemporalComparison {
  if (a.field !== b.field) return "UNKNOWN";
  const left = interval(a);
  const right = interval(b);
  if (left.point !== undefined && left.point === right.point) return "SAME_TIME";
  if (left.start !== undefined && right.start !== undefined && left.start === right.start) return "SAME_TIME";
  if (left.start === undefined || right.start === undefined) return "UNKNOWN";
  const leftEnd = left.end ?? Number.POSITIVE_INFINITY;
  const rightEnd = right.end ?? Number.POSITIVE_INFINITY;
  if (left.start <= rightEnd && right.start <= leftEnd) return "OVERLAPPING";
  return "PROGRESSION";
}
