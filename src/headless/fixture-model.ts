import type { Completion } from "../gateway/fixture-model.ts";

const quote = "Synthetic Candidate held the title Principal Engineer at Acme Synthetic Labs from 2021 through 2025.";

export function createHeadlessFixtureCompletion(): (body: Record<string, unknown>, agent: string) => Promise<Completion> {
  const calls = new Map<string, number>();
  return async (_body, agent) => {
    const call = (calls.get(agent) ?? 0) + 1;
    calls.set(agent, call);
    if (agent === "lead-researcher") {
      if (call === 1) return { toolCall: { name: "web.fetch", arguments: { url: "https://example.test/synthetic-source", focus: "employer title employment interval" } } };
      if (call === 2) return { toolCall: { name: "investigation.plan.set", arguments: { identityAnchors: ["Synthetic Candidate"], targets: [
        { id: "employment", section: "Career Experience", predicate: quote, importance: "HIGH", anchor: { kind: "PDF_TEXT", page: 1, lineStart: 1, lineEnd: 1, exact: "Synthetic Candidate" } },
        { id: "title", section: "Career Experience", predicate: "Held the title Principal Engineer", importance: "MEDIUM", anchor: { kind: "PDF_TEXT", page: 1, lineStart: 1, lineEnd: 1, exact: "Synthetic Candidate" } },
      ] } } };
      if (call === 3) return { toolCall: { name: "investigation.synthesis.begin", arguments: {} } };
      if (call === 4) return { toolCall: { name: "investigation.finding.upsert", arguments: { targetId: "employment", conclusion: "The reported employment is established.", status: "ESTABLISHED", evidence: [{ sourceRef: "S1", relation: "SUPPORTS", comment: "The first record establishes the employer and interval; it does not establish organizational ownership." }], rationale: "The captured record directly states the employer and interval.", remainingGap: null } } };
      if (call === 5) return { toolCall: { name: "web.fetch", arguments: { url: "https://example.test/synthetic-source-secondary", focus: "independent title corroboration" } } };
      if (call === 6) return { toolCall: { name: "investigation.finding.upsert", arguments: { targetId: "employment", conclusion: "The reported employment is established.", status: "ESTABLISHED", evidence: [{ sourceRef: "S1", relation: "SUPPORTS", comment: "The first record establishes the employer and interval; it does not establish organizational ownership." }, { sourceRef: "S2", relation: "SUPPORTS", comment: "The second record independently corroborates the interval; it does not prove leadership." }], rationale: "The second captured record resolved the remaining corroboration gap.", remainingGap: null } } };
      if (call === 7) return { toolCall: { name: "investigation.finding.upsert", arguments: { targetId: "title", conclusion: "The Principal Engineer title is established.", status: "ESTABLISHED", evidence: [{ sourceRef: "S2", relation: "SUPPORTS", comment: "The record establishes the title; it does not establish scope of authority." }], rationale: "The independent record states the title.", remainingGap: null } } };
      if (call === 8) return { toolCall: { name: "investigation.summary.set", arguments: { text: "The captured records establish the reported employment and title; evidence boundaries do not establish leadership or ownership.", targetIds: ["employment"] } } };
      if (call === 9) return { toolCall: { name: "investigation.commit", arguments: {} } };
      return { content: "Synthetic employment finding\n\nExact quote: “" + quote + "” [S1]\n\nThe source establishes the employer, title, and reported interval." };
    }
    return { content: "No additional synthetic research was required." };
  };
}
