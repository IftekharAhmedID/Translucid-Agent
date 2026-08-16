export const RESEARCH_PROMPT_CONTRACT = "Begin the headless investigation from /workspace/case/input/manifest.json. Complete one initial specialist wave and at most one targeted evidence-gap wave. For every material predicate assess identity, dates, directness, authority, source family, independence, contradictions, alternatives, and search coverage. Return a consolidated claim-by-claim natural-language research memo with exact [S#] citations, what each source establishes, unresolved gaps, and stop reasons. Reserve publishing time and stop when evidence is saturated, high-value routes are exhausted, or the deadline requires an explicitly unresolved conclusion.";

export function researchPrompt(deadline: string): string {
  return `${RESEARCH_PROMPT_CONTRACT} The research deadline is ${deadline}.`;
}
