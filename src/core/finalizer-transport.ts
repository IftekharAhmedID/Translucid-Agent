export type FinalizerOutputTransport = "NATIVE_JSON_SCHEMA" | "JSON_OBJECT";

export const FINALIZER_TEXT_MODE_MARKER = "TRANSLUCID_FINALIZER_TEXT_MODE";

const finalizerAgents = new Set([
  "evidence-critic",
  "fresh-adjudicator",
  "evidence-compiler",
  "evidence-linker",
  "resume-claim-compiler",
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
  input: { agent?: string; provider: "ZEN" | "GO"; model: string },
): Record<string, unknown> {
  if (!input.agent || !finalizerAgents.has(input.agent)) return body;
  if (JSON.stringify(body.messages ?? "").includes(FINALIZER_TEXT_MODE_MARKER)) return body;
  if (finalizerOutputTransport(input.provider, input.model) !== "JSON_OBJECT") return body;
  // MiMo's Go endpoint accepts the JSON-only instruction but rejects the
  // optional OpenAI response_format object. Host-side parsing remains strict.
  if (normalizedModel(input.model).startsWith("mimo-")) return body;
  const requestedTokens = Number(body.max_tokens ?? body.max_completion_tokens);
  const maxTokens = Number.isFinite(requestedTokens) && requestedTokens > 0
    ? Math.max(requestedTokens, 16_384)
    : 16_384;
  return { ...body, max_tokens: maxTokens, response_format: { type: "json_object" } };
}
