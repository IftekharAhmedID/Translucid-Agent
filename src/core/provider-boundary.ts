import type { DataClassification } from "./contracts.ts";

export type ProviderMode = "fixture" | "live";

export function assertProviderModeAllowsClassification(
  dataClassification: DataClassification,
  providerMode: ProviderMode,
): void {
  if (dataClassification === "PUBLIC_PROFESSIONAL" && providerMode !== "live") {
    throw new Error(
      "Public-professional investigations require live provider mode; fixture providers produce synthetic validation data only.",
    );
  }
}
