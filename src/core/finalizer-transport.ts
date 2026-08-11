export type FinalizerOutputTransport = "NATIVE_JSON_SCHEMA" | "JSON_OBJECT";

const finalizerAgents = new Set([
  "evidence-critic",
  "fresh-adjudicator",
  "evidence-compiler",
  "evidence-auditor",
]);

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
  const requestedTokens = Number(body.max_tokens ?? body.max_completion_tokens);
  const maxTokens = Number.isFinite(requestedTokens) && requestedTokens > 0
    ? Math.max(requestedTokens, 16_384)
    : 16_384;
  return { ...body, max_tokens: maxTokens, response_format: { type: "json_object" } };
}
