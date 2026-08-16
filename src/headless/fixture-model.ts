import type { Completion } from "../gateway/fixture-model.ts";

const quote = "Synthetic Candidate held the title Principal Engineer at Acme Synthetic Labs from 2021 through 2025.";

function publicationPromptPresent(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.some((message) => {
    if (!message || typeof message !== "object") return false;
    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== "user" && record.role !== "developer") return false;
    return /research is complete|publishing-only recovery|adversarial audit/i.test(JSON.stringify(record.content ?? ""));
  });
}

function userMessages(body: Record<string, unknown>): string[] {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== "user" && record.role !== "developer") return [];
    return [JSON.stringify(record.content ?? "")];
  });
}

export function createHeadlessFixtureCompletion(): (body: Record<string, unknown>, agent: string) => Promise<Completion> {
  const calls = new Map<string, number>();
  let publishingCalls = 0;
  let draftCalls = 0;
  let auditCalls = 0;
  return async (body, agent) => {
    const call = (calls.get(agent) ?? 0) + 1;
    calls.set(agent, call);
    if (agent === "lead-researcher") {
      if (publicationPromptPresent(body)) {
        const messages = userMessages(body).join("\n");
        const draftRequested = /stay in this lead session and draft/i.test(messages);
        const auditRequested = /adversarial audit/i.test(messages);
        if (draftRequested && !auditRequested) {
          draftCalls += 1;
          if (draftCalls === 1) return { toolCall: { name: "report.progress.get", arguments: {} } };
          if (draftCalls === 2) return { toolCall: { name: "report.summary.set", arguments: { summary: "The synthetic public record corroborates the reported Acme employment, title, and interval; no material conflict was found." } } };
          if (draftCalls === 3) return { toolCall: { name: "report.finding.upsert", arguments: { findingId: "F001", section: "Career Experience", claim: quote, anchor: { kind: "PDF_TEXT", page: 1, lineStart: 1, lineEnd: 1, exact: "Synthetic Candidate" }, evidence: "The captured synthetic source consistently corroborates the employer, title, and employment interval.", status: 2, sourceRefs: ["S1"] } } };
          if (draftCalls === 4) return { toolCall: { name: "report.progress.get", arguments: {} } };
          return { content: "The draft is complete; the separate audit turn must finalize it." };
        }
        if (auditRequested) {
          auditCalls += 1;
          if (auditCalls === 1) return { toolCall: { name: "report.finalize", arguments: {} } };
          return { content: "The calibrated report is finalized." };
        }
        publishingCalls += 1;
        if (publishingCalls === 1) return { toolCall: { name: "report.progress.get", arguments: {} } };
        if (publishingCalls === 2) return { toolCall: { name: "report.summary.set", arguments: { summary: "The synthetic public record corroborates the reported Acme employment, title, and interval; no material conflict was found." } } };
        if (publishingCalls === 3) return { toolCall: { name: "report.finding.upsert", arguments: { findingId: "F001", section: "Career Experience", claim: quote, anchor: { kind: "PDF_TEXT", page: 1, lineStart: 1, lineEnd: 1, exact: "Synthetic Candidate" }, evidence: "The captured synthetic source consistently corroborates the employer, title, and employment interval.", status: 2, sourceRefs: ["S1"] } } };
        if (publishingCalls === 4) return { toolCall: { name: "report.progress.get", arguments: {} } };
        return { toolCall: { name: "report.finalize", arguments: {} } };
      }
      if (call === 1) return { toolCall: { name: "task", arguments: { description: "Research synthetic employment", prompt: "WAVE: INITIAL\nVerify the synthetic candidate's Acme title and dates using the professional specialist.", subagent_type: "professional-researcher", background: false } } };
      return { content: `Synthetic employment finding\n\nExact quote: “${quote}” [S1]\n\nThe source establishes the employer, title, and reported interval.` };
    }
    if (agent === "professional-researcher") {
      if (call === 1) return { toolCall: { name: "web.fetch", arguments: { url: "https://example.test/synthetic-source" } } };
      if (call === 2) return { toolCall: { name: "research.ledger.upsert", arguments: { entries: [{ sourceRef: "S1", disposition: "EVIDENCE", relevance: "Acme employment", sourceFamily: "employer", claimLane: "chronology" }] } } };
      return { content: `Finding: synthetic Acme employment.\nExact quote: “${quote}” [S1]\nWhat it establishes: employer, title, and 2021–2025 interval.` };
    }
    return { content: "No additional synthetic research was required." };
  };
}
