type AssistantResult = {
  info: { role: string; structured?: unknown; error?: { name?: string } };
  parts: Array<{ type: string; text?: string }>;
};

export function extractStructuredOutput(message: AssistantResult): unknown {
  if (message.info.role !== "assistant") throw new Error("Session did not return an assistant response.");
  if (message.info.structured !== undefined) return message.info.structured;

  const text = message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
  try {
    return JSON.parse(text);
  } catch {
    const partTypes = message.parts.map((part) => part.type).join(",") || "none";
    throw new Error(`Session did not produce valid structured output (error=${message.info.error?.name ?? "none"}, parts=${partTypes}).`);
  }
}
