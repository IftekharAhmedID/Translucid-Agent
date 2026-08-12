export const RESEARCH_PROMPT_CONTRACT = "Begin the headless investigation from /workspace/case/input/manifest.json. Complete one initial specialist wave and at most one exact-gap targeted wave. Return a consolidated natural-language research memo with exact [S#] citations. Reserve finalization time and stop when material gaps are resolved or honestly exhausted.";

export const DOSSIER_PROMPT_CONTRACT = `MODE: EVIDENCE_DOSSIER

Create a complete evidence dossier from the parsed input and preserved research. Human-readable Markdown is allowed, but every model-authored claim, facet, evidence item, summary field, timeline item, and coverage disposition must also appear in the fixed one-line TL_* record format defined by your agent instructions. Build TL_COVERAGE directly from every material assertion in the parsed input; the lead memo is advisory and may be absent. Exact quotes must occur verbatim in memo-cited immutable sources. Use source.excerpts when needed.

Serialization rules: output every TL_* marker followed by exactly one valid JSON object on that same line. Facet key values are lower-snake-case ASCII identifiers matching ^[a-z][a-z0-9_]{0,63}$, for example employer or current_role; never use spaces, punctuation, or title case for facet keys. sourceSpan is always an object such as {"text":"Example Corp"} or {"page":1,"text":"Example Corp"}; never output a sourceSpan string. sourceLocation is always an object such as {"path":"pages[0].text"}; never output a sourceLocation string. On repair, emit the complete dossier again, including exactly one TL_SUMMARY and all TL_CLAIM, TL_FACET, TL_EVIDENCE, TL_TIMELINE, and TL_COVERAGE records; do not emit only a patch or an error explanation.`;

export const ENCODER_PROMPT_CONTRACT = "MODE: STRUCTURED_ENCODING\n\nFaithfully encode the supplied dossier into the requested result draft schema. Do not add, omit, reinterpret, summarize, or repair dossier semantics. Backend code assigns canonical IDs, source authority, verdicts, strength, and statistics.";

export const COVERAGE_PROMPT_CONTRACT = "MODE: COVERAGE_ONLY\n\nExhaustively account for every non-empty résumé line. Return only the focused coverage schema: frozen claim outlines with exact page, lineStart, lineEnd, and text spans plus declared facets, then either CLAIMED coverage linked to a claim or one bounded EXCLUDED reason (CONTACT_DETAIL, SECTION_HEADING, BARE_SKILL, SUBJECTIVE_DESCRIPTION, DUPLICATE). Every low-materiality factual assertion is still a claim. Do not use research memos, source metadata, tools, or skills.";

export const PACKET_PROMPT_CONTRACT = "MODE: EVIDENCE_PACKET\n\nCompile exactly the assigned claim outlines. Return one compiled entry and one note for every declared facet, plus every eligible SUPPORTS or CONTRADICTS evidence item found in the preserved research. Preserve claim wording, source spans, materiality, and facet keys exactly. Use only cited immutable source references and exact source paths/quotes. Never invent verdicts, strengths, IDs, or evidence.";

export const SUMMARY_TIMELINE_PROMPT_CONTRACT = "MODE: SUMMARY_TIMELINE\n\nReturn only a summary and timeline object for the supplied merged claims and evidence. Reference only known claim and evidence keys. Do not add or change claims, facets, evidence, verdicts, strengths, source authority, or identifiers. No tools, memos, or source fetches.";

export const AUDITOR_PROMPT_CONTRACT = "Independently audit this deterministically validated result against the parsed input and evidence dossier. Do not research or call tools; immutable source bytes and exact quotations have already been host-verified. Mark REPAIR_REQUIRED only for a material defect. Warnings do not require repair.";

export function researchPrompt(deadline: string): string {
  return `${RESEARCH_PROMPT_CONTRACT} The research deadline is ${deadline}.`;
}

export function promptWithPayload(contract: string, payload: unknown): string {
  return `${contract}\n\n${JSON.stringify(payload)}`;
}
