const EMPTY_TASK_RESULT = /<task_result>\s*<\/task_result>/i;

export function needsChildHandoffContinuation(output: string): boolean {
  return EMPTY_TASK_RESULT.test(output);
}

export function publicAssistantText(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .filter((part) => part.type === "text" && part.text?.trim())
    .map((part) => part.text!.trim())
    .join("\n")
    .slice(0, 8_000);
}

export function childTaskEnvelope(sessionId: string, result: string): string {
  return `<task id="${sessionId}" state="completed">\n<task_result>\n${result.trim()}\n</task_result>\n</task>`;
}
