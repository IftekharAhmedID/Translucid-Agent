type AssistantResult = {
  info: { role: string; structured?: unknown; error?: { name?: string } };
  parts: Array<{ type: string; text?: string }>;
};

export type StructuredOutputRecovery = "SAME_SESSION_COMPLETION" | "FRESH_SCHEMA_RETRY";

export function structuredOutputRecovery(error: unknown): StructuredOutputRecovery {
  return error instanceof Error && error.message.startsWith("NO_TEXT_OUTPUT:")
    ? "SAME_SESSION_COMPLETION"
    : "FRESH_SCHEMA_RETRY";
}

function firstBalancedJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  return undefined;
}

export function extractStructuredOutput(message: AssistantResult): unknown {
  if (message.info.role !== "assistant") throw new Error("Session did not return an assistant response.");
  if (message.info.error) throw new Error(`OPENCODE_MESSAGE_ERROR:${message.info.error.name ?? "UnknownError"}`);
  if (message.info.structured !== undefined) return message.info.structured;

  const text = message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
  if (!text) {
    const partTypes = message.parts.map((part) => part.type).join(",") || "none";
    throw new Error(`NO_TEXT_OUTPUT: assistant response contained no structured data or text (parts=${partTypes}).`);
  }
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  try {
    const candidate = fenced?.[1] ?? firstBalancedJsonObject(text) ?? text;
    return JSON.parse(candidate);
  } catch {
    const partTypes = message.parts.map((part) => part.type).join(",") || "none";
    throw new Error(`Session did not produce valid structured output (error=none, parts=${partTypes}, textCharacters=${text.length}).`);
  }
}
