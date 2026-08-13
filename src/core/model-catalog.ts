export const PAID_GO_MODEL_IDS = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "mimo-v2.5-pro",
] as const;

export const PAID_GO_MODEL_SET = new Set<string>(PAID_GO_MODEL_IDS);

export type FinalizerModelDefinition = {
  id: string;
  providerId: "translucid" | "translucid-anthropic";
  protocol: "OPENAI_CHAT" | "ANTHROPIC_MESSAGES";
  upstreamPath: "/v1/chat/completions" | "/v1/messages";
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  contextTokens: number;
  outputTokens: number;
};

// ponytail: one static catalog keeps model policy, transport, and pricing in one place.
export const FINALIZER_MODEL_CATALOG: readonly FinalizerModelDefinition[] = [
  { id: "minimax-m3", providerId: "translucid-anthropic", protocol: "ANTHROPIC_MESSAGES", upstreamPath: "/v1/messages", inputUsdPerMillion: 0.30, outputUsdPerMillion: 1.20, contextTokens: 512_000, outputTokens: 128_000 },
  { id: "mimo-v2.5-pro", providerId: "translucid", protocol: "OPENAI_CHAT", upstreamPath: "/v1/chat/completions", inputUsdPerMillion: 0.435, outputUsdPerMillion: 0.87, contextTokens: 200_000, outputTokens: 32_000 },
  { id: "deepseek-v4-pro", providerId: "translucid", protocol: "OPENAI_CHAT", upstreamPath: "/v1/chat/completions", inputUsdPerMillion: 0.435, outputUsdPerMillion: 0.87, contextTokens: 200_000, outputTokens: 32_000 },
] as const;

export function finalizerModelDefinition(model: string): FinalizerModelDefinition {
  const definition = FINALIZER_MODEL_CATALOG.find(({ id }) => id === model.split("/").at(-1));
  if (!definition) throw new Error(`Unsupported finalizer model ${model}.`);
  return definition;
}
