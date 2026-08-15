export const RESEARCH_PROMPT_CONTRACT = "Begin the headless investigation from /workspace/case/input/manifest.json. Complete one initial specialist wave and at most one exact-gap targeted wave. Return a consolidated natural-language research memo with exact [S#] citations. Reserve publishing time and stop when material gaps are resolved or honestly exhausted.";

export function researchPrompt(deadline: string): string {
  return `${RESEARCH_PROMPT_CONTRACT} The research deadline is ${deadline}.`;
}
