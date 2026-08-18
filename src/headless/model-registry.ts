export type ResearchModelProtocol = "CHAT_COMPLETIONS" | "RESPONSES";

export type ResearchModelSpec = {
  id: string;
  displayName: string;
  protocol: ResearchModelProtocol;
  variant: "xhigh";
  reasoningEffort: "max" | "xhigh";
  contextLimit: number;
  outputLimit: number;
  default: boolean;
};

export const MODEL_REGISTRY = {
  "deepseek-v4-pro": {
    id: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    protocol: "CHAT_COMPLETIONS",
    variant: "xhigh",
    reasoningEffort: "max",
    contextLimit: 1_000_000,
    outputLimit: 384_000,
    default: true,
  },
  "gpt-5.6-luna": {
    id: "gpt-5.6-luna",
    displayName: "GPT 5.6 Luna",
    protocol: "RESPONSES",
    variant: "xhigh",
    reasoningEffort: "xhigh",
    contextLimit: 200_000,
    outputLimit: 32_000,
    default: false,
  },
} satisfies Record<string, ResearchModelSpec>;

export type ResearchModelId = keyof typeof MODEL_REGISTRY;

export const DEFAULT_RESEARCH_MODEL: ResearchModelId = Object.values(MODEL_REGISTRY).find(({ default: isDefault }) => isDefault)!.id as ResearchModelId;

export function resolveResearchModel(value?: string): ResearchModelSpec {
  const id = value?.trim() || DEFAULT_RESEARCH_MODEL;
  const spec = MODEL_REGISTRY[id as ResearchModelId];
  if (!spec) throw new Error(`Unsupported research model: ${id}`);
  return spec;
}

export function modelUsesResponses(model: string): boolean {
  return resolveResearchModel(model).protocol === "RESPONSES";
}
