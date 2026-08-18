import type { Capability } from "../core/capabilities.ts";
import type { ProviderCostSource, ToolName } from "./contracts.ts";

export type ProviderExecutionContext = {
  runId: string;
  agent: string;
  sessionId: string;
  investigationId?: string;
  resolvedDiscoveryRef?: string;
  batchId?: string;
  batchIndex?: number;
};

export type ProviderArtifactInput = {
  kind: string;
  sourceUrl: string;
  title?: string;
  date?: string;
  highlight?: string;
  mimeType?: string;
  content: unknown;
  status?: number;
  provenance?: Record<string, unknown>;
};

export type ProviderNetworkResult = {
  data: unknown;
  sourceUrl: string;
  status?: number;
  costUsd: number;
  costSource: ProviderCostSource;
  artifacts?: ProviderArtifactInput[];
};

export type ConcreteProviderResult = ProviderNetworkResult & {
  provider: string;
  providerRoute: string;
  artifactIds: string[];
  evidenceEligibleArtifactIds: string[];
  artifactRefs?: Array<{ ref: string; kind: string; sourceUrl?: string }>;
  reused: boolean;
};

export type ProviderCallInput = {
  context: ProviderExecutionContext;
  requestMetadata?: { questionId: string; claimIds: string[]; publicRationale: string };
  capability: Capability;
  semanticTool: ToolName;
  provider: string;
  providerRoute: string;
  networkArguments: Record<string, unknown>;
  countCeiling: number;
  providerBudgetUsd: number;
  knownCost?: Pick<ProviderNetworkResult, "costUsd" | "costSource">;
  run: (signal: AbortSignal, onAttempt: (attempt: number) => void) => Promise<ProviderNetworkResult>;
};

export type ProviderCallBackend = (input: ProviderCallInput) => Promise<ConcreteProviderResult>;
