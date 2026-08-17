import type { Completion } from "../gateway/fixture-model.ts";

const quote = "Synthetic Candidate held the title Principal Engineer at Acme Synthetic Labs from 2021 through 2025.";

function latestUserText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
  const user = [...messages].reverse().find((message) => message && typeof message === "object" && ((message as { role?: unknown }).role === "user" || (message as { type?: unknown }).type === "message")) as { content?: unknown } | undefined;
  if (typeof user?.content === "string") return user.content;
  if (!Array.isArray(user?.content)) return "";
  return user.content.flatMap((part) => part && typeof part === "object"
    ? [typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : typeof (part as { input_text?: unknown }).input_text === "string" ? (part as { input_text: string }).input_text : ""]
    : []).join("\n");
}

export function createHeadlessFixtureCompletion(): (body: Record<string, unknown>, agent: string) => Promise<Completion> {
  const calls = new Map<string, number>();
  return async (body, agent) => {
    const call = (calls.get(agent) ?? 0) + 1;
    calls.set(agent, call);
    if (agent === "lead-researcher") {
      if (call === 1) return { toolCall: { name: "web.fetch", arguments: { url: "https://example.test/synthetic-source", focus: "employer title employment interval" } } };
      if (call === 2) return { toolCall: { name: "research.state.set", arguments: { publicationReady: true, identityAnchors: ["Synthetic Candidate"], claims: [{ id: "F001", claim: quote, provisionalStatus: "established", supportingRefs: ["S1"], conflictingRefs: [], remainingGap: null, importance: "material" }] } } };
      return { content: `Synthetic employment finding\n\nExact quote: “${quote}” [S1]\n\nThe source establishes the employer, title, and reported interval.` };
    }
    if (agent === "report-writer") {
      const prompt = latestUserText(body);
      if (/publication summary/i.test(prompt)) return { content: JSON.stringify({ summary: "The synthetic public record corroborates the reported Acme employment, title, and interval; no material conflict was found.", researchClaimIds: ["F001"] }) };
      return { content: JSON.stringify({ findings: [{ findingId: "F001", section: "Career Experience", claim: quote, anchor: { kind: "PDF_TEXT", page: 1, lineStart: 1, lineEnd: 1, exact: "Synthetic Candidate" }, evidence: "The captured synthetic source consistently corroborates the employer, title, and employment interval.", status: 2, sourceRefs: ["S1"], researchClaimIds: ["F001"] }] }) };
    }
    return { content: "No additional synthetic research was required." };
  };
}
