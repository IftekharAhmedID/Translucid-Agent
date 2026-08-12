import type { Completion } from "../gateway/fixture-model.ts";
import type { InvestigationDraft } from "./result-contract.ts";

const quote = "Synthetic Candidate held the title Principal Engineer at Acme Synthetic Labs from 2021 through 2025.";

function fixtureDraft(): InvestigationDraft {
  return {
    summary: {
      professionalIdentity: { status: "PARTIAL", text: "The synthetic public fixture consistently identifies the submitted professional record.", claimKeys: ["acme-employment"], evidenceKeys: ["acme-record"] },
      professionalTimelineSummary: "The synthetic source supports the reported 2021–2025 Acme chronology.",
      timelineClaimKeys: ["acme-employment"],
      timelineEvidenceKeys: ["acme-record"],
      strongestEvidenceByClaim: [{ claimKey: "acme-employment", facetKeys: ["employer", "title", "tenure"], evidenceKeys: ["acme-record"] }],
      materialInconsistencies: [],
      limitations: ["This result uses deterministic synthetic provider fixtures for architecture validation."],
    },
    claims: [{
      key: "acme-employment",
      category: "EMPLOYMENT",
      statement: quote,
      materiality: "HIGH",
      sourceSpan: { page: 1, text: "Principal Engineer at Acme Synthetic Labs from 2021 through 2025" },
      explanation: "The deterministic synthetic institutional source directly supports all declared employment facets.",
      facets: [
        { key: "employer", label: "Employer: Acme Synthetic Labs", materiality: "HIGH", status: "SUPPORTED", note: "The source names Acme Synthetic Labs." },
        { key: "title", label: "Title: Principal Engineer", materiality: "HIGH", status: "SUPPORTED", note: "The source names the Principal Engineer title." },
        { key: "tenure", label: "Employment interval: 2021 through 2025", materiality: "HIGH", status: "SUPPORTED", note: "The source states the 2021 through 2025 interval." },
      ],
    }],
    evidence: [{ key: "acme-record", claimKey: "acme-employment", facetKeys: ["employer", "title", "tenure"], relation: "SUPPORTS", sourceRef: "S1", exactQuote: quote, sourceLocation: { path: "records[0].text" } }],
    timeline: [{ label: "Acme Synthetic Labs employment", validFrom: "2021", validTo: "2025", claimKeys: ["acme-employment"], evidenceKeys: ["acme-record"] }],
  };
}

function fixtureDossier(): string {
  const draft = fixtureDraft();
  return [
    "# Synthetic evidence dossier",
    ...draft.claims.map((claim) => `TL_CLAIM ${JSON.stringify({
      key: claim.key,
      category: claim.category,
      statement: claim.statement,
      materiality: claim.materiality,
      sourceSpan: claim.sourceSpan,
      explanation: claim.explanation,
    })}`),
    ...draft.claims.flatMap((claim) => claim.facets.map((facet) => `TL_FACET ${JSON.stringify({
      claimKey: claim.key,
      key: facet.key,
      label: facet.label,
      materiality: facet.materiality,
      note: facet.note,
    })}`)),
    ...draft.evidence.map((evidence) => `TL_EVIDENCE ${JSON.stringify(evidence)}`),
    `TL_SUMMARY ${JSON.stringify(draft.summary)}`,
    ...draft.timeline.map((timeline) => `TL_TIMELINE ${JSON.stringify(timeline)}`),
    `TL_COVERAGE ${JSON.stringify({
      assertion: quote,
      sourceSpan: draft.claims[0]!.sourceSpan,
      disposition: "CLAIMED",
      claimKey: "acme-employment",
    })}`,
  ].join("\n");
}

function promptText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const user = [...messages].reverse().find((message) => message && typeof message === "object" && (message as { role?: unknown }).role === "user") as { content?: unknown } | undefined;
  if (typeof user?.content === "string") return user.content;
  if (Array.isArray(user?.content)) return user.content.map((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "").join("\n");
  const parts = Array.isArray(body.parts) ? body.parts : [];
  return parts.map((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "").join("\n");
}

function promptPayload(body: Record<string, unknown>): Record<string, unknown> {
  const text = promptText(body);
  const marker = text.indexOf("\n\n{");
  if (marker < 0) return {};
  try {
    return JSON.parse(text.slice(marker + 2).split("\n\nReturn only one complete JSON object.")[0]!) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function fixtureCoverage(body: Record<string, unknown>): Record<string, unknown> {
  const input = promptPayload(body).input as { pages?: Array<{ page: number; lines: Array<{ line: number; text: string }> }> } | undefined;
  const lines = input?.pages?.flatMap((page) => page.lines.map((line) => ({ ...line, page: page.page }))) ?? [];
  const effectiveLines = lines.length ? lines : [
    { page: 1, line: 1, text: "Synthetic Candidate" },
    { page: 1, line: 2, text: "Principal Engineer at Example Corp" },
    { page: 1, line: 3, text: "Python, TypeScript" },
  ];
  const first = effectiveLines[0]?.text ?? "Synthetic Candidate";
  const second = effectiveLines.find((line) => /engineer|worked|acme/i.test(line.text)) ?? effectiveLines[1] ?? { page: 1, line: 2, text: "Principal Engineer at Example Corp" };
  const claims = [
    { key: "identity", category: "IDENTITY", statement: `The résumé identifies ${first}.`, materiality: "HIGH", sourceSpan: { page: effectiveLines[0]?.page ?? 1, lineStart: effectiveLines[0]?.line ?? 1, lineEnd: effectiveLines[0]?.line ?? 1, text: first }, facets: [{ key: "name", label: `Name: ${first}`, materiality: "HIGH" }] },
    { key: "acme-employment", category: "EMPLOYMENT", statement: quote, materiality: "HIGH", sourceSpan: { page: second.page, lineStart: second.line, lineEnd: second.line, text: second.text }, facets: [{ key: "employer", label: "Employer: Acme Synthetic Labs", materiality: "HIGH" }, { key: "title", label: "Title: Principal Engineer", materiality: "HIGH" }, { key: "tenure", label: "Employment interval: 2021 through 2025", materiality: "HIGH" }] },
  ];
  return {
    claims,
    coverage: effectiveLines.filter((line) => line.text.trim()).map((line) => line.text === first
      ? { span: { page: line.page, lineStart: line.line, lineEnd: line.line, text: line.text }, disposition: "CLAIMED", claimKey: "identity" }
      : /python|typescript|javascript/i.test(line.text)
        ? { span: { page: line.page, lineStart: line.line, lineEnd: line.line, text: line.text }, disposition: "EXCLUDED", reason: "BARE_SKILL" }
        : { span: { page: line.page, lineStart: line.line, lineEnd: line.line, text: line.text }, disposition: "CLAIMED", claimKey: "acme-employment" }),
  };
}

function fixturePacket(body: Record<string, unknown>): Record<string, unknown> {
  const outlines = (promptPayload(body).claimOutlines as Array<{ key: string; facets: Array<{ key: string }> }> | undefined) ?? [
    { key: "identity", facets: [{ key: "name" }] },
    { key: "acme-employment", facets: [{ key: "employer" }, { key: "title" }, { key: "tenure" }] },
  ];
  const claims = (outlines ?? []).map((outline) => ({ claimKey: outline.key, explanation: "The preserved synthetic institutional record supports the declared résumé assertion.", facets: outline.facets.map((facet) => ({ key: facet.key, note: "The preserved synthetic source provides a matching observation." })) }));
  const evidence = (outlines ?? []).flatMap((outline) => [{ key: `${outline.key}-source`, claimKey: outline.key, facetKeys: outline.facets.map((facet) => facet.key), relation: "SUPPORTS", sourceRef: "S1", exactQuote: quote, sourceLocation: { path: "records[0].text" } }]);
  return { claims, evidence };
}

function fixtureSummary(body: Record<string, unknown>): Record<string, unknown> {
  const payload = promptPayload(body);
  const claims = (payload.claims as Array<{ claimKey: string }> | undefined)?.map((claim) => claim.claimKey) ?? ["identity", "acme-employment"];
  const evidence = (payload.evidence as Array<{ key: string; claimKey: string }> | undefined) ?? [
    { key: "identity-source", claimKey: "identity" },
    { key: "acme-employment-source", claimKey: "acme-employment" },
  ];
  const identity = claims.includes("identity") ? "identity" : claims[0]!;
  const identityEvidence = evidence.find((item) => item.claimKey === identity)?.key ?? evidence[0]?.key ?? "acme-employment-source";
  const timelineClaim = claims.includes("acme-employment") ? "acme-employment" : claims[0]!;
  const timelineEvidence = evidence.find((item) => item.claimKey === timelineClaim)?.key ?? evidence[0]?.key ?? identityEvidence;
  const fallbackFacets = (claimKey: string) => claimKey === "identity" ? ["name"] : ["employer", "title", "tenure"];
  return {
    summary: {
      professionalIdentity: { status: "RESOLVED", text: "The synthetic public fixture identifies the submitted professional record.", claimKeys: [identity], evidenceKeys: [identityEvidence] },
      professionalTimelineSummary: "The synthetic source supports the reported Acme chronology.",
      timelineClaimKeys: [timelineClaim],
      timelineEvidenceKeys: [timelineEvidence],
      strongestEvidenceByClaim: claims.map((claimKey) => ({ claimKey, facetKeys: (payload.claims as Array<{ claimKey: string; facets: Array<{ key: string }> }> | undefined)?.find((claim) => claim.claimKey === claimKey)?.facets.map((facet) => facet.key) ?? fallbackFacets(claimKey), evidenceKeys: evidence.filter((item) => item.claimKey === claimKey).map((item) => item.key) })),
      materialInconsistencies: [],
      limitations: ["This result uses deterministic synthetic provider fixtures for architecture validation."],
    },
    timeline: [{ label: "Acme Synthetic Labs employment", validFrom: "2021", validTo: "2025", claimKeys: [timelineClaim], evidenceKeys: [timelineEvidence] }],
  };
}

export function createHeadlessFixtureCompletion(): (body: Record<string, unknown>, agent: string) => Promise<Completion> {
  const calls = new Map<string, number>();
  return async (body, agent) => {
    const call = (calls.get(agent) ?? 0) + 1;
    calls.set(agent, call);
    if (agent === "lead-researcher") {
      if (call === 1) return { toolCall: { name: "task", arguments: { description: "Research synthetic employment", prompt: "WAVE: INITIAL\nVerify the synthetic candidate's Acme title and dates using the professional specialist.", subagent_type: "professional-researcher", background: false } } };
      return { content: `Synthetic employment finding\n\nExact quote: “${quote}” [S1]\n\nThe source establishes the employer, title, and reported interval. This is a deterministic synthetic fixture with no material conflict.` };
    }
    if (agent === "professional-researcher") {
      if (call === 1) return { toolCall: { name: "web.fetch", arguments: { url: "https://example.test/synthetic-source" } } };
      return { content: `Finding: synthetic Acme employment.\nExact quote: “${quote}” [S1]\nWhat it establishes: employer, title, and 2021–2025 interval.\nConflict or uncertainty: none inside the synthetic fixture.\nRemaining material gap: none.` };
    }
    const nativeStructuredOutput = Array.isArray(body.tools) && body.tools.some((tool) => {
      if (!tool || typeof tool !== "object") return false;
      const functionDefinition = (tool as { function?: { name?: unknown } }).function;
      return functionDefinition?.name === "StructuredOutput";
    });
    if (agent === "evidence-compiler") {
      const serialized = JSON.stringify(body);
      if (serialized.includes("MODE: COVERAGE_ONLY")) {
        const value = fixtureCoverage(body);
        return nativeStructuredOutput ? { toolCall: { name: "StructuredOutput", arguments: value } } : { content: JSON.stringify(value) };
      }
      if (serialized.includes("MODE: EVIDENCE_PACKET")) {
        const value = fixturePacket(body);
        return nativeStructuredOutput ? { toolCall: { name: "StructuredOutput", arguments: value } } : { content: JSON.stringify(value) };
      }
      if (serialized.includes("MODE: SUMMARY_TIMELINE")) {
        const value = fixtureSummary(body);
        return nativeStructuredOutput ? { toolCall: { name: "StructuredOutput", arguments: value } } : { content: JSON.stringify(value) };
      }
      if (JSON.stringify(body).includes("MODE: EVIDENCE_DOSSIER")) return { content: fixtureDossier() };
      const draft = fixtureDraft();
      return nativeStructuredOutput
        ? { toolCall: { name: "StructuredOutput", arguments: draft } }
        : { content: JSON.stringify(draft) };
    }
    if (agent === "evidence-auditor") {
      const audit = { status: "PASSED", defects: [] };
      return nativeStructuredOutput
        ? { toolCall: { name: "StructuredOutput", arguments: audit } }
        : { content: JSON.stringify(audit) };
    }
    return { content: "No additional synthetic research was required." };
  };
}
