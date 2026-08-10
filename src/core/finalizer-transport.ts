export type FinalizerOutputTransport = "NATIVE_JSON_SCHEMA" | "JSON_OBJECT";

const finalizerAgents = new Set(["evidence-critic", "fresh-adjudicator"]);

function normalizedModel(model: string): string {
  return model.split("/").at(-1)?.toLowerCase() ?? model.toLowerCase();
}

export function finalizerOutputTransport(provider: "ZEN" | "GO", model: string): FinalizerOutputTransport {
  // OpenCode's native structured output forces a tool choice. GO's DeepSeek V4
  // thinking models accept automatic tools but reject forced tool_choice.
  return provider === "GO" && normalizedModel(model).startsWith("deepseek-v4-")
    ? "JSON_OBJECT"
    : "NATIVE_JSON_SCHEMA";
}

export function prepareFinalizerUpstreamBody(
  body: Record<string, unknown>,
  input: { agent?: string; provider: "ZEN" | "GO"; model: string },
): Record<string, unknown> {
  if (!input.agent || !finalizerAgents.has(input.agent)) return body;
  if (finalizerOutputTransport(input.provider, input.model) !== "JSON_OBJECT") return body;
  return { ...body, response_format: { type: "json_object" } };
}
