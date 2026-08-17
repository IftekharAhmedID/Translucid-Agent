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
  let publishingCalls = 0;
  return async (body, agent) => {
    const call = (calls.get(agent) ?? 0) + 1;
    calls.set(agent, call);
    if (agent === "lead-researcher") {
      if (/research is now frozen|research is complete/i.test(latestUserText(body))) {
        publishingCalls += 1;
        if (publishingCalls === 1) return { toolCall: { name: "research.state.set", arguments: { identityAnchors: ["Synthetic Candidate"], claims: [{ id: "F001", claim: quote, provisionalStatus: "established", supportingRefs: ["S1"], conflictingRefs: [], remainingGap: null, importance: "material" }] } } };
        if (publishingCalls === 2) return { toolCall: { name: "report.progress.get", arguments: {} } };
        if (publishingCalls === 3) return { toolCall: { name: "report.summary.set", arguments: { summary: "The synthetic public record corroborates the reported Acme employment, title, and interval; no material conflict was found." } } };
        if (publishingCalls === 4) return { toolCall: { name: "report.finding.upsert", arguments: { findingId: "F001", section: "Career Experience", claim: quote, anchor: { kind: "PDF_TEXT", page: 1, lineStart: 1, lineEnd: 1, exact: "Synthetic Candidate" }, evidence: "The captured synthetic source consistently corroborates the employer, title, and employment interval.", status: 2, sourceRefs: ["S1"] } } };
        if (publishingCalls === 5) return { toolCall: { name: "report.progress.get", arguments: {} } };
        return { toolCall: { name: "report.finalize", arguments: {} } };
      }
      if (call === 1) return { toolCall: { name: "web.fetch", arguments: { url: "https://example.test/synthetic-source", focus: "employer title employment interval" } } };
      return { content: `Synthetic employment finding\n\nExact quote: “${quote}” [S1]\n\nThe source establishes the employer, title, and reported interval.` };
    }
    return { content: "No additional synthetic research was required." };
  };
}
