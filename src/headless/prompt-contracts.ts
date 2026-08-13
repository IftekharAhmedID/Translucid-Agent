export const RESEARCH_PROMPT_CONTRACT = "Begin the headless investigation from /workspace/case/input/manifest.json. Complete one initial specialist wave and at most one exact-gap targeted wave. Return a consolidated natural-language research memo with exact [S#] citations. Reserve finalization time and stop when material gaps are resolved or honestly exhausted.";

export const DOSSIER_PROMPT_CONTRACT = `MODE: EVIDENCE_DOSSIER

Create a complete evidence dossier from the parsed input and preserved research. Human-readable Markdown is allowed, but every model-authored claim, facet, evidence item, summary field, timeline item, and coverage disposition must also appear in the fixed one-line TL_* record format defined by your agent instructions. Build TL_COVERAGE directly from every material assertion in the parsed input; the lead memo is advisory and may be absent. Exact quotes must occur verbatim in memo-cited immutable sources. Use source.excerpts when needed.

Serialization rules: output every TL_* marker followed by exactly one valid JSON object on that same line. Facet key values are lower-snake-case ASCII identifiers matching ^[a-z][a-z0-9_]{0,63}$, for example employer or current_role; never use spaces, punctuation, or title case for facet keys. sourceSpan is always an object such as {"text":"Example Corp"} or {"page":1,"text":"Example Corp"}; never output a sourceSpan string. sourceLocation is always an object such as {"path":"pages[0].text"}; never output a sourceLocation string. On repair, emit the complete dossier again, including exactly one TL_SUMMARY and all TL_CLAIM, TL_FACET, TL_EVIDENCE, TL_TIMELINE, and TL_COVERAGE records; do not emit only a patch or an error explanation.`;

export const ENCODER_PROMPT_CONTRACT = "MODE: STRUCTURED_ENCODING\n\nFaithfully encode the supplied dossier into the requested result draft schema. Do not add, omit, reinterpret, summarize, or repair dossier semantics. Backend code assigns canonical IDs, source authority, verdicts, strength, and statistics.";

export const COVERAGE_PROMPT_CONTRACT = "MODE: COVERAGE_ONLY\n\nExhaustively account for every non-empty résumé line. Return only the focused coverage schema: frozen claim outlines with exact page, lineStart, lineEnd, and text spans plus declared facets, then either CLAIMED coverage linked to a claim or one bounded EXCLUDED reason (CONTACT_DETAIL, SECTION_HEADING, BARE_SKILL, SUBJECTIVE_DESCRIPTION, DUPLICATE). Every low-materiality factual assertion is still a claim. Facet labels must be self-contained atomic assertions with at least two concrete tokens; never emit generic labels such as role, employer, location, or institution alone. Do not use research memos, source metadata, tools, or skills.";

export const PACKET_PROMPT_CONTRACT = "MODE: EVIDENCE_PACKET\n\nCompile exactly the assigned claim outlines. Return one compiled entry and one note for every declared facet, plus every eligible SUPPORTS or CONTRADICTS evidence item found in the preserved research. Preserve claim wording, source spans, materiality, and facet keys exactly. Use only cited immutable source references whose sourceAuthority is not CONTEXT or DISCOVERY_ONLY; those references are preserved as context but cannot be evidence, so leave the facet unresolved when no eligible source remains. Use exact source paths/quotes. Never invent verdicts, strengths, IDs, or evidence.";

export const SUMMARY_TIMELINE_PROMPT_CONTRACT = "MODE: SUMMARY_TIMELINE\n\nReturn only a summary and timeline object for the supplied merged claims and evidence. Reference only known claim and evidence keys. Do not add or change claims, facets, evidence, verdicts, strengths, source authority, or identifiers. No tools, memos, or source fetches.";

export const AUDITOR_PROMPT_CONTRACT = "Independently audit this deterministically validated result against the parsed input and evidence dossier. Do not research or call tools; immutable source bytes and exact quotations have already been host-verified. Mark REPAIR_REQUIRED only for a material defect. Warnings do not require repair. Every material defect must declare stage PACKET, SUMMARY, or CANONICAL; packet defects must include zero-based packetIndex plus affected claimKeys/evidenceKeys. If a defect cannot be scoped to one packet or the summary, report it as stage AUDIT so the host fails closed rather than regenerating valid work.";

export const CLAIM_BATCH_PROMPT_CONTRACT = `MODE: CLAIM_BATCH

Process only the supplied unresolved résumé line window. Return at most five claims. Every supplied line must appear exactly once in a claim facet, an exclusion, or deferredLineIds. The earliest unresolved line must not be deferred. Use the exact supplied line IDs; never return page numbers, line numbers, copied source text, canonical IDs, verdicts, strengths, or evidence. A facet is one self-contained atomic assertion and must map to one or more supplied line IDs. Preserve uncertain facts as claims rather than silently excluding them.`;

export const EVIDENCE_LINK_BATCH_PROMPT_CONTRACT = `MODE: EVIDENCE_LINK_BATCH

Process exactly the assigned frozen claims. Return one entry for every assigned claim and one facet note for every declared facet. Use source.excerpts for exact immutable wording when needed. Evidence edges may reference only excerpt refs returned by that tool. Return excerpt refs, not source paths, source refs, quotes, authority, IDs, verdicts, or strengths. Zero edges is valid when a facet remains unresolved.`;

export const V4_AUDITOR_PROMPT_CONTRACT = `MODE: INCREMENTAL_AUDIT

Audit the supplied frozen line dispositions, claims, evidence, summary, and timeline. Report only material defects. A defect must identify one stage (CLAIM, EVIDENCE, SUMMARY, or AUDIT), exactly the affected durable claim IDs/evidence IDs, and whether it is safely repairable without changing line ownership. Never rewrite records or introduce new evidence.`;

export function researchPrompt(deadline: string): string {
  return `${RESEARCH_PROMPT_CONTRACT} The research deadline is ${deadline}.`;
}

export function promptWithPayload(contract: string, payload: unknown): string {
  return `${contract}\n\n${JSON.stringify(payload)}`;
}
