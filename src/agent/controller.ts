import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { GlobalEvent, Session } from "@opencode-ai/sdk/v2/client";
import { z } from "zod";

import { validateAdjudication } from "../core/adjudication.ts";
import { adjudicationOutputSchema, type AdjudicationOutput } from "../core/contracts.ts";
import { getSql } from "../db/client.ts";
import { insertAgentEvent } from "../db/investigations.ts";
import type { RunHandle } from "../runtime/types.ts";
import { buildFrozenEvidenceBundle } from "./bundle.ts";
import { extractStructuredOutput } from "./structured-output.ts";

const directory = "/workspace/case";
const criticSchema = z.object({
  acceptedEvidenceIds: z.array(z.uuid()),
  rejectedEvidence: z.array(z.object({ evidenceId: z.uuid(), reason: z.string().min(1).max(2_000) })),
  claimConcerns: z.array(z.object({ claimId: z.uuid(), concerns: z.array(z.string().min(1).max(2_000)) })),
  identityConcerns: z.array(z.string().min(1).max(2_000)),
  chronologyConcerns: z.array(z.string().min(1).max(2_000)),
  limitations: z.array(z.string().min(1).max(2_000)),
}).strict();

type ControllerInput = {
  investigationId: string;
  runId: string;
  handle: RunHandle;
  deadlineAt: Date;
  signal: AbortSignal;
};

function unwrap<T>(result: { data?: T; error?: unknown }, action: string): T {
  if (result.error || result.data === undefined) throw new Error(`${action} failed: ${JSON.stringify(result.error ?? "missing data")}`);
  return result.data;
}

function eventSessionId(event: GlobalEvent): string | undefined {
  if (!("properties" in event.payload)) return undefined;
  const properties = event.payload.properties as Record<string, unknown>;
  if (typeof properties.sessionID === "string") return properties.sessionID;
  const info = properties.info;
  return info && typeof info === "object" && typeof (info as { id?: unknown }).id === "string" ? String((info as { id: string }).id) : undefined;
}

function normalizedEvent(event: GlobalEvent): { type: string; tool?: string; status: string; payload: Record<string, unknown> } | undefined {
  const payload = event.payload;
  if (payload.type === "message.part.updated") {
    const part = payload.properties.part;
    if (part.type === "reasoning" || part.type === "text") return undefined;
    if (part.type === "tool") return { type: "TOOL_STATUS", tool: part.tool, status: part.state.status.toUpperCase(), payload: { callId: part.callID } };
    return undefined;
  }
  if (payload.type === "session.status") return { type: "SESSION_STATUS", status: payload.properties.status.type.toUpperCase(), payload: {} };
  if (payload.type === "session.idle") return { type: "SESSION_IDLE", status: "IDLE", payload: {} };
  if (payload.type === "session.created") return { type: "SESSION_CREATED", status: "STARTED", payload: { parentId: payload.properties.info.parentID ?? null, title: payload.properties.info.title } };
  if (payload.type === "session.compacted") return { type: "SESSION_COMPACTED", status: "COMPLETED", payload: {} };
  if (payload.type === "session.error") return { type: "SESSION_ERROR", status: "ERROR", payload: { errorType: payload.properties.error?.name ?? "UnknownError" } };
  if (payload.type === "todo.updated") return { type: "TODO_UPDATED", status: "UPDATED", payload: { todos: payload.properties.todos.map(({ content, priority, status }) => ({ content, priority, status })) } };
  return undefined;
}

export class OpenCodeInvestigationController {
  async run(input: ControllerInput): Promise<AdjudicationOutput> {
    const client = createOpencodeClient({ baseUrl: input.handle.openCodeUrl, headers: input.handle.accessHeaders, throwOnError: false });
    const knownSessions = new Set<string>();
    const eventAbort = new AbortController();
    const relay = this.relayEvents(client, input, knownSessions, eventAbort.signal);
    const abortAll = async () => {
      const parents = [...knownSessions];
      const childLookups = await Promise.allSettled(parents.map((sessionID) => client.session.children({ sessionID, directory })));
      for (const lookup of childLookups) {
        if (lookup.status === "fulfilled" && lookup.value.data) {
          for (const child of lookup.value.data) knownSessions.add(child.id);
        }
      }
      return Promise.allSettled([...knownSessions].map((sessionID) => client.session.abort({ sessionID, directory })));
    };
    const abortListener = () => { void abortAll(); };
    input.signal.addEventListener("abort", abortListener, { once: true });
    try {
      const lead = await this.createSession(client, "Translucid lead investigation", "lead-investigator", input.signal);
      knownSessions.add(lead.id);
      input.signal.throwIfAborted();
      await getSql()`UPDATE runs SET opencode_primary_session_id = ${lead.id}, updated_at = now() WHERE id = ${input.runId}`;
      await client.session.promptAsync({ sessionID: lead.id, directory, agent: "lead-investigator", model: { providerID: "translucid", modelID: "deepseek-v4-flash" }, variant: "max", parts: [{ type: "text", text: "Begin the authorized investigation from /workspace/case/input/manifest.json. Obey the classification declared in that manifest. Persist all claims, entities, questions, observations, evidence, and public notes through semantic tools. Complete the durable frontier; do not write a final adjudication." }] }, { signal: input.signal });
      const remainingAtResearchStart = Math.max(1, input.deadlineAt.getTime() - Date.now());
      const reviewReserve = Math.min(8 * 60_000, Math.floor(remainingAtResearchStart * (8 / 30)));
      const researchDeadline = new Date(input.deadlineAt.getTime() - reviewReserve);
      const researchFinished = await this.waitForIdle(client, lead.id, input, researchDeadline);
      if (!researchFinished) {
        await abortAll();
        await insertAgentEvent({ investigationId: input.investigationId, runId: input.runId, phase: "RESEARCH", agent: "runner", eventType: "PHASE_DEADLINE", status: "EXHAUSTED", publicRationale: "Research stopped at its phase deadline so saved evidence could proceed to frozen review and adjudication.", payload: { researchDeadline: researchDeadline.toISOString() } });
      }

      const frozen = await buildFrozenEvidenceBundle(input.investigationId, input.runId);
      const critic = await this.createSession(client, "Frozen evidence critic", "evidence-critic", input.signal);
      knownSessions.add(critic.id);
      const criticMessage = unwrap(await client.session.prompt({ sessionID: critic.id, directory, agent: "evidence-critic", model: { providerID: "translucid", modelID: "deepseek-v4-flash" }, variant: "max", format: { type: "json_schema", schema: z.toJSONSchema(criticSchema), retryCount: 2 }, parts: [{ type: "text", text: `Audit this frozen durable bundle. Do not research. Return the required structured audit.\n${JSON.stringify(frozen)}` }] }, { signal: input.signal }), "critic prompt");
      const criticOutput = criticSchema.parse(extractStructuredOutput(criticMessage));
      const frozenEvidence = frozen.evidence as Array<{ id: string; claimIds: string[] }>;
      const allEvidenceIds = new Set(frozenEvidence.map(({ id }) => id));
      const knownClaimIds = new Set((frozen.claims as Array<{ id: string }>).map(({ id }) => id));
      for (const id of [...criticOutput.acceptedEvidenceIds, ...criticOutput.rejectedEvidence.map(({ evidenceId }) => evidenceId)]) {
        if (!allEvidenceIds.has(id)) throw new Error(`Critic referenced unknown evidence ID ${id}.`);
      }
      for (const concern of criticOutput.claimConcerns) {
        if (!knownClaimIds.has(concern.claimId)) throw new Error(`Critic referenced unknown claim ID ${concern.claimId}.`);
      }
      const rejectedEvidenceIds = new Set(criticOutput.rejectedEvidence.map(({ evidenceId }) => evidenceId));
      const acceptedEvidenceIds = new Set(criticOutput.acceptedEvidenceIds.filter((id) => !rejectedEvidenceIds.has(id)));

      const adjudicator = await this.createSession(client, "Fresh final adjudication", "fresh-adjudicator", input.signal);
      knownSessions.add(adjudicator.id);
      await getSql()`UPDATE runs SET opencode_adjudicator_session_id = ${adjudicator.id}, updated_at = now() WHERE id = ${input.runId}`;
      const adjudicationMessage = unwrap(await client.session.prompt({ sessionID: adjudicator.id, directory, agent: "fresh-adjudicator", model: { providerID: "translucid", modelID: "deepseek-v4-flash" }, variant: "max", format: { type: "json_schema", schema: z.toJSONSchema(adjudicationOutputSchema), retryCount: 2 }, parts: [{ type: "text", text: `Adjudicate only this frozen evidence bundle and critic audit. Return the required non-ranking JSON.\nBUNDLE:\n${JSON.stringify(frozen)}\nCRITIC:\n${JSON.stringify(criticOutput)}` }] }, { signal: input.signal }), "adjudicator prompt");
      const evidenceClaimIds = new Map(frozenEvidence.map(({ id, claimIds }) => [id, new Set(claimIds)]));
      const output = validateAdjudication(extractStructuredOutput(adjudicationMessage), acceptedEvidenceIds, knownClaimIds, evidenceClaimIds);
      await this.persistAdjudication(input.investigationId, input.runId, output);
      return output;
    } finally {
      input.signal.removeEventListener("abort", abortListener);
      eventAbort.abort();
      await relay.catch(() => undefined);
    }
  }

  private async createSession(client: ReturnType<typeof createOpencodeClient>, title: string, agent: string, signal: AbortSignal): Promise<Session> {
    return unwrap(await client.session.create({ directory, title, agent, model: { id: "deepseek-v4-flash", providerID: "translucid", variant: agent.includes("critic") || agent.includes("adjudicator") ? "max" : "high" } }, { signal }), "session creation");
  }

  private async waitForIdle(client: ReturnType<typeof createOpencodeClient>, sessionId: string, input: ControllerInput, phaseDeadline: Date): Promise<boolean> {
    let observedBusy = false;
    const startedAt = Date.now();
    while (Date.now() < phaseDeadline.getTime()) {
      if (input.signal.aborted) throw new DOMException("Investigation aborted", "AbortError");
      const statuses = unwrap(await client.session.status({ directory }), "session status");
      const status = statuses[sessionId];
      if (status?.type === "busy" || status?.type === "retry") observedBusy = true;
      if (observedBusy && (!status || status.type === "idle")) return true;
      if (!observedBusy && Date.now() - startedAt >= 3_000 && (!status || status.type === "idle")) {
        const messages = unwrap(await client.session.messages({ sessionID: sessionId, directory, limit: 2 }), "session messages");
        const latest = messages.at(-1);
        if (latest?.info.role === "assistant") {
          if (latest.info.error) throw new Error(`OpenCode session failed: ${latest.info.error.name}`);
          return true;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  private async relayEvents(client: ReturnType<typeof createOpencodeClient>, input: ControllerInput, knownSessions: Set<string>, signal: AbortSignal): Promise<void> {
    const stream = await client.global.event({ signal });
    for await (const event of stream.stream) {
      if (signal.aborted || event.directory !== directory) continue;
      const sessionId = eventSessionId(event);
      if (event.payload.type === "session.created" && event.payload.properties.info.parentID && knownSessions.has(event.payload.properties.info.parentID)) knownSessions.add(event.payload.properties.info.id);
      if (sessionId && !knownSessions.has(sessionId)) continue;
      const normalized = normalizedEvent(event);
      if (!normalized) continue;
      await insertAgentEvent({ investigationId: input.investigationId, runId: input.runId, phase: "AGENT", agent: "opencode", sessionId, eventType: normalized.type, tool: normalized.tool, source: "OPENCODE", status: normalized.status, payload: normalized.payload });
    }
  }

  private async persistAdjudication(investigationId: string, runId: string, output: AdjudicationOutput): Promise<void> {
    await getSql().begin(async (transaction) => {
      for (const finding of output.findings) {
        await transaction`
          INSERT INTO findings (
            investigation_id, run_id, claim_id, verdict, strength, explanation,
            supporting_evidence_ids, contradicting_evidence_ids, limitations
          ) VALUES (
            ${investigationId}, ${runId}, ${finding.claimId}, ${finding.verdict},
            ${finding.strength}, ${finding.explanation},
            ${finding.supportingEvidenceIds}::uuid[],
            ${finding.contradictingEvidenceIds}::uuid[], ${finding.limitations}
          )
        `;
      }
      await transaction`UPDATE investigations SET final_summary = ${transaction.json(JSON.parse(JSON.stringify(output.summary)))}, updated_at = now() WHERE id = ${investigationId}`;
    });
  }
}
