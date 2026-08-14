export type FinalizerOutputTransport = "NATIVE_JSON_SCHEMA" | "JSON_OBJECT";

export const FINALIZER_TEXT_MODE_MARKER = "TRANSLUCID_FINALIZER_TEXT_MODE";

const finalizerAgents = new Set([
  "evidence-critic",
  "fresh-adjudicator",
  "evidence-compiler",
  "evidence-auditor",
]);

function normalizedModel(model: string): string {
  return model.split("/").at(-1)?.toLowerCase() ?? model.toLowerCase();
}

export function finalizerOutputTransport(...args: ["ZEN" | "GO", string]): FinalizerOutputTransport {
  // The installed OpenCode SDK rejects its native schema envelope before the
  // request reaches either provider. Keep finalizers on the compatible JSON
  // path; host-side schemas remain the authoritative validation gate.
  void args;
  return "JSON_OBJECT";
}

export function prepareFinalizerUpstreamBody(
  body: Record<string, unknown>,
  input: { agent?: string; provider: "ZEN" | "GO"; model: string; protocol?: "OPENAI_CHAT" | "ANTHROPIC_MESSAGES" },
): Record<string, unknown> {
  if (!input.agent || !finalizerAgents.has(input.agent)) return body;
  const requestedTokens = Number(body.max_tokens ?? body.max_completion_tokens);
  const maxTokens = Number.isFinite(requestedTokens) && requestedTokens > 0
    ? Math.min(requestedTokens, 16_384)
    : 16_384;
  const prepared: Record<string, unknown> = { ...body, max_tokens: maxTokens };
  delete prepared.max_completion_tokens;
  if (JSON.stringify(body.messages ?? "").includes(FINALIZER_TEXT_MODE_MARKER)) return prepared;
  if (finalizerOutputTransport(input.provider, input.model) !== "JSON_OBJECT") return prepared;
  if (input.protocol === "ANTHROPIC_MESSAGES") return prepared;
  // MiMo's Go endpoint accepts the JSON-only instruction but rejects the
  // optional OpenAI response_format object. Host-side parsing remains strict.
  if (normalizedModel(input.model).startsWith("mimo-")) return prepared;
  return { ...prepared, response_format: { type: "json_object" } };
}
