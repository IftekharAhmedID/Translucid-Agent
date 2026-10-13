export type ResearchModelProtocol = "CHAT_COMPLETIONS" | "RESPONSES";
export type ResearchReasoningVariant = "medium" | "xhigh" | "default";
export type ResearchWireReasoningEffort = "medium" | "max" | "xhigh";
export type ResearchEffectiveReasoningEffort = "medium" | "high" | "max" | "xhigh" | "provider-default";

export type ResearchModelSpec = {
  id: string;
  displayName: string;
  protocol: ResearchModelProtocol;
  variant: ResearchReasoningVariant;
  reasoningEffort: ResearchWireReasoningEffort | undefined;
  effectiveReasoningEffort: ResearchEffectiveReasoningEffort;
  contextLimit: number;
  outputLimit: number;
  default: boolean;
};

export const MODEL_REGISTRY = {
  "deepseek/deepseek-v4.1-flash": {
    id: "deepseek/deepseek-v4.1-flash", displayName: "DeepSeek V4.1 Flash (OpenRouter)", protocol: "CHAT_COMPLETIONS",
    variant: "medium", reasoningEffort: "medium", effectiveReasoningEffort: "high",
    contextLimit: 1_048_576, outputLimit: 384_000, default: false,
  },
  "muse-spark-1.3-contributor-free": {
    id: "muse-spark-1.3-contributor-free", displayName: "Muse Spark 1.3 Contributor Free", protocol: "RESPONSES",
    variant: "medium", reasoningEffort: "medium", effectiveReasoningEffort: "medium",
    contextLimit: 1_048_576, outputLimit: 131_072, default: false,
  },
  "big-pickle": {
    id: "big-pickle", displayName: "Big Pickle", protocol: "CHAT_COMPLETIONS",
    variant: "default", reasoningEffort: undefined, effectiveReasoningEffort: "provider-default",
    contextLimit: 200_000, outputLimit: 32_000, default: false,
  },
  "cat-jam-free": {
    id: "cat-jam-free", displayName: "Cat Jam Free", protocol: "CHAT_COMPLETIONS",
    variant: "medium", reasoningEffort: "medium", effectiveReasoningEffort: "high",
    contextLimit: 262_144, outputLimit: 131_072, default: false,
  },
  "deepseek-v4-pro": {
    id: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    protocol: "CHAT_COMPLETIONS",
    variant: "medium",
    reasoningEffort: "medium",
    effectiveReasoningEffort: "high",
    contextLimit: 1_000_000,
    outputLimit: 384_000,
    default: true,
  },
  "deepseek-v4-flash": {
    id: "deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    protocol: "CHAT_COMPLETIONS",
    variant: "medium",
    reasoningEffort: "medium",
    effectiveReasoningEffort: "high",
    contextLimit: 1_000_000,
    outputLimit: 384_000,
    default: false,
  },
  "gpt-5.6-luna": {
    id: "gpt-5.6-luna",
    displayName: "GPT 5.6 Luna",
    protocol: "RESPONSES",
    variant: "xhigh",
    reasoningEffort: "xhigh",
    effectiveReasoningEffort: "xhigh",
    contextLimit: 200_000,
    outputLimit: 32_000,
    default: false,
  },
} satisfies Record<string, ResearchModelSpec>;

export type ResearchModelId = keyof typeof MODEL_REGISTRY;

export const DEFAULT_RESEARCH_MODEL: ResearchModelId = Object.values(MODEL_REGISTRY).find(({ default: isDefault }) => isDefault)!.id as ResearchModelId;

export function resolveResearchModel(value?: string, requestedVariant?: string): ResearchModelSpec {
  const id = value?.trim() || DEFAULT_RESEARCH_MODEL;
  const spec = MODEL_REGISTRY[id as ResearchModelId];
  if (!spec) throw new Error(`Unsupported research model: ${id}`);
  const variant = requestedVariant?.trim() || spec.variant;
  if (variant === spec.variant) return spec;
  if (id === "muse-spark-1.3-contributor-free" && variant === "xhigh") return { ...spec, variant: "xhigh", reasoningEffort: "xhigh", effectiveReasoningEffort: "xhigh" };
  if ((id === "deepseek-v4-pro" || id === "deepseek-v4-flash" || id === "deepseek/deepseek-v4.1-flash" || id === "cat-jam-free") && variant === "xhigh") return { ...spec, variant: "xhigh", reasoningEffort: "max", effectiveReasoningEffort: "max" };
  throw new Error(`Research model ${id} does not support reasoning variant ${variant}.`);
}

export function modelUsesResponses(model: string): boolean {
  return resolveResearchModel(model).protocol === "RESPONSES";
}
