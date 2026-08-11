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

export function createHeadlessFixtureCompletion(): (body: Record<string, unknown>, agent: string) => Promise<Completion> {
  const calls = new Map<string, number>();
  return async (_body, agent) => {
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
    if (agent === "evidence-compiler") return { content: JSON.stringify(fixtureDraft()) };
    if (agent === "evidence-auditor") return { content: JSON.stringify({ status: "PASSED", defects: [] }) };
    return { content: "No additional synthetic research was required." };
  };
}
