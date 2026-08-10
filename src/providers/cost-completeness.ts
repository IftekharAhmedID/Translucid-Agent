import type { ProviderCostSource } from "./contracts.ts";

export type ProviderCostCompleteness = "STRICT" | "PARTIAL" | "UNKNOWN";

export function providerCostCompleteness(calls: Array<{ costSource?: ProviderCostSource | null }>): ProviderCostCompleteness {
  if (calls.length === 0) return "UNKNOWN";
  const known = calls.filter(({ costSource }) => costSource && costSource !== "UNKNOWN").length;
  if (known === calls.length) return "STRICT";
  return known === 0 ? "UNKNOWN" : "PARTIAL";
}
