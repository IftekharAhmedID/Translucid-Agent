import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { GlobalEvent, Session } from "@opencode-ai/sdk/v2/client";
import { z } from "zod";

import { validateAdjudication, validateFindingBatch, validateInvestigationSummary } from "../core/adjudication.ts";
import { getConfig } from "../core/config.ts";
import type { AdjudicationOutput } from "../core/contracts.ts";
import { forcedFinalizationAt } from "../core/deadlines.ts";
import { finalizerOutputTransport } from "../core/finalizer-transport.ts";
import { getSql } from "../db/client.ts";
import { insertAgentEvent } from "../db/investigations.ts";
import { reconcileResearchFrontier } from "../db/state.ts";
import type { RunHandle } from "../runtime/types.ts";
import { buildAdjudicationBundle, buildFrozenEvidenceBundle } from "./bundle.ts";
import {
  buildCriticBatchBundle,
  buildFindingBatchBundle,
  buildSummaryBundle,
  criticJsonExample,
  criticOutputSchema,
  findingBatchOutputSchema,
  mapWithConcurrency,
  mergeCriticBatches,
  mergeFindingBatches,
  partitionClaims,
  summaryOutputSchema,
  validateCriticBatch,
} from "./finalization.ts";
import { extractStructuredOutput, structuredOutputRecovery } from "./structured-output.ts";
import { researchCompletionAction, researchContinuationAllowed } from "./research-completion.ts";

const directory = "/workspace/case";
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
      const researchDeadline = forcedFinalizationAt(input.deadlineAt, getConfig().finalizationReserveMs);
      await client.session.promptAsync({ sessionID: lead.id, directory, agent: "lead-investigator", model: { providerID: "translucid", modelID: getConfig().researchModel }, variant: getConfig().reasoningVariant, parts: [{ type: "text", text: `Begin the authorized investigation from /workspace/case/input/manifest.json. The raw PDF has already been parsed and removed; use only the manifest's structured text/JSON paths and sparse-page images. Obey the declared classification and your ordered workflow. Persist durable state through semantic tools. Return as soon as every durable research question is terminal; never continue merely because time remains. Emergency finalization begins at ${researchDeadline.toISOString()} and the hard case deadline is ${input.deadlineAt.toISOString()}. Do not write a final adjudication.` }] }, { signal: input.signal });
      const researchFinished = await this.waitForResearchCompletion(client, lead.id, input, researchDeadline);
      if (!researchFinished) {
        await abortAll();
        await insertAgentEvent({ investigationId: input.investigationId, runId: input.runId, phase: "RESEARCH", agent: "runner", eventType: "FORCED_FINALIZATION", status: "EXHAUSTED", publicRationale: "The emergency finalization reserve began, so unfinished research stopped and durable state was preserved for review.", payload: { forcedFinalizationAt: researchDeadline.toISOString() } });
      }

      await reconcileResearchFrontier(input.investigationId, input.runId);
      const frozen = await buildFrozenEvidenceBundle(input.investigationId, input.runId);
      const frozenEvidence = frozen.evidence as Array<{ id: string; claimIds: string[] }>;
      const allEvidenceIds = new Set(frozenEvidence.map(({ id }) => id));
      const frozenClaims = frozen.claims as Array<{ id: string }>;
      const knownClaimIds = new Set(frozenClaims.map(({ id }) => id));
      const criticClaimBatches = partitionClaims(frozenClaims, 20);
      const criticOutputs = await mapWithConcurrency(criticClaimBatches, 2, async (batch, index) => {
        const claimIds = batch.map(({ id }) => id);
        const criticBundle = buildCriticBatchBundle(frozen, claimIds);
        const eligibleEvidenceIds = new Set((criticBundle.evidence as Array<{ id: string }>).map(({ id }) => id));
        const result = await this.promptStructured({
          client,
          input,
          knownSessions,
          title: `Frozen evidence critic ${index + 1} of ${criticClaimBatches.length}`,
          agent: "evidence-critic",
          phase: "CRITIC",
          prompt: `Audit exactly these ${claimIds.length} frozen claim packets. Do not research or cite evidence outside this packet. Return only exceptions in the required structured audit.\n${JSON.stringify(criticBundle)}`,
          schema: criticOutputSchema,
          jsonExample: criticJsonExample,
        });
        return validateCriticBatch(result.value, new Set(claimIds), eligibleEvidenceIds);
      });
      const criticOutput = mergeCriticBatches(criticOutputs);
      for (const id of criticOutput.rejectedEvidence.map(({ evidenceId }) => evidenceId)) {
        if (!allEvidenceIds.has(id)) throw new Error(`Critic referenced unknown evidence ID ${id}.`);
      }
      for (const concern of criticOutput.claimConcerns) {
        if (!knownClaimIds.has(concern.claimId)) throw new Error(`Critic referenced unknown claim ID ${concern.claimId}.`);
      }
      const rejectedEvidenceIds = new Set(criticOutput.rejectedEvidence.map(({ evidenceId }) => evidenceId));
      const acceptedEvidenceIds = new Set([...allEvidenceIds].filter((id) => !rejectedEvidenceIds.has(id)));
      const adjudicationBundle = buildAdjudicationBundle(frozen, acceptedEvidenceIds, criticOutput);

      const evidenceClaimIds = new Map(frozenEvidence.map(({ id, claimIds }) => [id, new Set(claimIds)]));
      const claims = (adjudicationBundle.claims as Array<{ id: string }>);
      const claimBatches = partitionClaims(claims);
      const batchSessionIds = new Array<string>(claimBatches.length);
      const findingBatches = await mapWithConcurrency(claimBatches, 2, async (batch, index) => {
        const claimIds = batch.map(({ id }) => id);
        const batchBundle = buildFindingBatchBundle(adjudicationBundle, claimIds);
        const batchJsonExample = {
          findings: claimIds.map((claimId) => ({
            claimId,
            verdict: "UNRESOLVED",
            strength: "WEAK",
            explanation: "The eligible evidence is insufficient to resolve this claim.",
            supportingEvidenceIds: [],
            contradictingEvidenceIds: [],
            limitations: ["Only evidence in this claim packet may be cited."],
          })),
        };
        const batchPrompt = `Adjudicate exactly these ${claimIds.length} claim packets. For each claim, cite only evidence IDs in that same packet's eligibleEvidenceIds. Evidence listed for another claim is ineligible even when its quote appears relevant. If the eligible evidence does not establish the claim, return UNRESOLVED with empty citation arrays. Return only the focused findings object.\n${JSON.stringify(batchBundle)}`;
        try {
          const adjudication = await this.promptStructured({
            client,
            input,
            knownSessions,
            title: `Fresh finding adjudication ${index + 1} of ${claimBatches.length}`,
            agent: "fresh-adjudicator",
            phase: "ADJUDICATION",
            prompt: batchPrompt,
            schema: findingBatchOutputSchema,
            jsonExample: batchJsonExample,
          });
          batchSessionIds[index] = adjudication.sessionId;
          try {
            return validateFindingBatch(adjudication.value, new Set(claimIds), acceptedEvidenceIds, evidenceClaimIds);
          } catch (validationError) {
            const validationMessage = validationError instanceof Error ? validationError.message : String(validationError);
            await insertAgentEvent({
              investigationId: input.investigationId,
              runId: input.runId,
              phase: "ADJUDICATION",
              agent: "fresh-adjudicator",
              sessionId: adjudication.sessionId,
              eventType: "ADJUDICATION_BATCH_CORRECTION",
              status: "RETRYING",
              publicRationale: "A five-claim batch failed citation validation, so one fresh bounded correction was requested. A second failure will stop finalization.",
              payload: { batch: index + 1, validationError: validationMessage },
            });
            const correction = await this.promptStructured({
              client,
              input,
              knownSessions,
              title: `Fresh finding adjudication ${index + 1} correction`,
              agent: "fresh-adjudicator",
              phase: "ADJUDICATION",
              prompt: `${batchPrompt}\n\nThe previous independent response was rejected by deterministic validation: ${validationMessage}\nCorrect that exact defect. Do not cite an evidence ID outside the corresponding claim packet. This is the only correction attempt.`,
              schema: findingBatchOutputSchema,
              jsonExample: batchJsonExample,
            });
            batchSessionIds[index] = correction.sessionId;
            return validateFindingBatch(correction.value, new Set(claimIds), acceptedEvidenceIds, evidenceClaimIds);
          }
        } catch (error) {
          throw new Error(`Adjudication batch ${index + 1}/${claimBatches.length} failed on ${getConfig().finalizerOpenCodeProvider}: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
      const findings = mergeFindingBatches(findingBatches, claims.map(({ id }) => id));
      const summaryResult = await this.promptStructured({
        client,
        input,
        knownSessions,
        title: "Fresh investigation summary",
        agent: "fresh-adjudicator",
        phase: "ADJUDICATION",
        prompt: `Summarize only the validated findings, accepted evidence, entity resolution, observations and stated capability limitations. Return the focused non-ranking summary object.\n${JSON.stringify(buildSummaryBundle(adjudicationBundle, findings))}`,
        schema: summaryOutputSchema,
        jsonExample: {
          summary: {
            professionalIdentity: { status: "AMBIGUOUS", summary: "Example JSON shape only.", evidenceIds: [] },
            professionalTimelineSummary: "Example JSON shape only.",
            professionalTimelineEvidenceIds: [],
            strongestEvidenceIds: [],
            materialInconsistencies: [],
            unresolvedMaterialClaimIds: [],
            investigationLimitations: ["Example JSON shape only."],
          },
        },
      });
      const summary = validateInvestigationSummary(summaryResult.value.summary, acceptedEvidenceIds, knownClaimIds, evidenceClaimIds);
      await getSql()`UPDATE runs SET opencode_adjudicator_session_id = ${summaryResult.sessionId}, runtime_handle = COALESCE(runtime_handle, '{}'::jsonb) || ${getSql().json({ finalization: { provider: getConfig().finalizerOpenCodeProvider, batchSessionIds, summarySessionId: summaryResult.sessionId } })}::jsonb, updated_at = now() WHERE id = ${input.runId}`;
      const output = validateAdjudication({ summary, findings }, acceptedEvidenceIds, knownClaimIds, evidenceClaimIds);
      await this.persistAdjudication(input.investigationId, input.runId, output);
      return output;
    } finally {
      input.signal.removeEventListener("abort", abortListener);
      eventAbort.abort();
      await relay.catch(() => undefined);
    }
  }

  private async createSession(client: ReturnType<typeof createOpencodeClient>, title: string, agent: string, signal: AbortSignal): Promise<Session> {
    const modelId = agent === "lead-investigator" ? getConfig().researchModel : getConfig().finalizerModel;
    return unwrap(await client.session.create({ directory, title, agent, model: { id: modelId, providerID: "translucid", variant: getConfig().reasoningVariant } }, { signal }), "session creation");
  }

  private async promptStructured<T>({
    client,
    input,
    knownSessions,
    title,
    agent,
    phase,
    prompt,
    schema,
    jsonExample,
  }: {
    client: ReturnType<typeof createOpencodeClient>;
    input: ControllerInput;
    knownSessions: Set<string>;
    title: string;
    agent: "evidence-critic" | "fresh-adjudicator";
    phase: "CRITIC" | "ADJUDICATION";
    prompt: string;
    schema: z.ZodType<T>;
    jsonExample: unknown;
  }): Promise<{ value: T; sessionId: string }> {
    const config = getConfig();
    const transport = finalizerOutputTransport(config.finalizerOpenCodeProvider, config.finalizerModel);
    let nativeError: unknown;
    if (transport === "NATIVE_JSON_SCHEMA") {
      const native = await this.createSession(client, title, agent, input.signal);
      knownSessions.add(native.id);
      try {
        const message = unwrap(await client.session.prompt({
          sessionID: native.id,
          directory,
          agent,
          model: { providerID: "translucid", modelID: config.finalizerModel },
          variant: config.reasoningVariant,
          format: { type: "json_schema", schema: z.toJSONSchema(schema), retryCount: 2 },
          parts: [{ type: "text", text: prompt }],
        }, { signal: input.signal }), `${phase.toLowerCase()} prompt`);
        return { value: schema.parse(extractStructuredOutput(message)), sessionId: native.id };
      } catch (error) {
        nativeError = error;
      }
      await insertAgentEvent({
        investigationId: input.investigationId,
        runId: input.runId,
        phase,
        agent,
        sessionId: native.id,
        eventType: "STRUCTURED_OUTPUT_FALLBACK",
        status: "RETRYING",
        publicRationale: "Native structured output was unavailable; retrying once in a fresh top-level session using JSON-only text.",
        payload: { nativeError: nativeError instanceof Error ? nativeError.message : "Unknown structured-output error" },
      });
    } else {
      await insertAgentEvent({
        investigationId: input.investigationId,
        runId: input.runId,
        phase,
        agent,
        eventType: "STRUCTURED_OUTPUT_COMPATIBILITY_MODE",
        status: "STARTED",
        publicRationale: "The configured GO reasoning model does not support forced tool choice; using its JSON-object response mode with backend schema validation.",
        payload: { transport },
      });
    }

    const fallback = await this.createSession(client, `${title} JSON`, agent, input.signal);
    knownSessions.add(fallback.id);
    const fallbackMessage = unwrap(await client.session.prompt({
      sessionID: fallback.id,
      directory,
      agent,
      model: { providerID: "translucid", modelID: config.finalizerModel },
      variant: config.reasoningVariant,
      parts: [{
        type: "text",
        text: `${prompt}\n\nReturn only one complete JSON object with no prose. Do not echo source text. It must validate against this JSON Schema:\n${JSON.stringify(z.toJSONSchema(schema))}\nExample JSON shape (replace example values with case-grounded values):\n${JSON.stringify(jsonExample)}`,
      }],
    }, { signal: input.signal }), `${phase.toLowerCase()} JSON prompt`);
    try {
      return { value: schema.parse(extractStructuredOutput(fallbackMessage)), sessionId: fallback.id };
    } catch (fallbackError) {
      const second = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      if (transport === "JSON_OBJECT") {
        const recovery = structuredOutputRecovery(fallbackError);
        if (recovery === "SAME_SESSION_COMPLETION") {
          await insertAgentEvent({
            investigationId: input.investigationId,
            runId: input.runId,
            phase,
            agent,
            sessionId: fallback.id,
            eventType: "STRUCTURED_OUTPUT_COMPLETION_CONTINUATION",
            status: "RETRYING",
            publicRationale: "The GO model completed its analysis but omitted the final JSON, so the same session received one bounded final-answer continuation without repeating the audit.",
            payload: { firstError: second.slice(0, 1_000) },
          });
          const continuationMessage = unwrap(await client.session.prompt({
            sessionID: fallback.id,
            directory,
            agent,
            model: { providerID: "translucid", modelID: config.finalizerModel },
            variant: config.reasoningVariant,
            parts: [{
              type: "text",
              text: `Your preceding turn completed the analysis but omitted the final answer. Do not repeat the audit, revisit sources, or add prose. Using only the analysis already completed in this session, return one complete compact JSON object now. It must validate against this JSON Schema:\n${JSON.stringify(z.toJSONSchema(schema))}\nExample JSON shape (replace example values with case-grounded values):\n${JSON.stringify(jsonExample)}`,
            }],
          }, { signal: input.signal }), `${phase.toLowerCase()} same-session JSON completion`);
          try {
            return { value: schema.parse(extractStructuredOutput(continuationMessage)), sessionId: fallback.id };
          } catch (continuationError) {
            const third = continuationError instanceof Error ? continuationError.message : String(continuationError);
            throw new Error(`${phase} JSON-object output omitted its answer (${second}) and its one same-session completion also failed (${third}).`);
          }
        }
        await insertAgentEvent({
          investigationId: input.investigationId,
          runId: input.runId,
          phase,
          agent,
          sessionId: fallback.id,
          eventType: "STRUCTURED_OUTPUT_JSON_RETRY",
          status: "RETRYING",
          publicRationale: "The first GO JSON-object response contained an answer that failed deterministic JSON or schema validation, so one fresh bounded correction was requested. A second failure stops finalization.",
          payload: { firstError: second.slice(0, 1_000) },
        });
        const retry = await this.createSession(client, `${title} JSON retry`, agent, input.signal);
        knownSessions.add(retry.id);
        const retryMessage = unwrap(await client.session.prompt({
          sessionID: retry.id,
          directory,
          agent,
          model: { providerID: "translucid", modelID: config.finalizerModel },
          variant: config.reasoningVariant,
          parts: [{
            type: "text",
            text: `${prompt}\n\nThe previous independent response failed deterministic JSON/schema validation: ${second.slice(0, 1_000)}\nReturn one complete, compact JSON object with no prose and do not echo source text. Keep concern, explanation, and limitation strings concise. This is the only JSON retry. It must validate against this JSON Schema:\n${JSON.stringify(z.toJSONSchema(schema))}\nExample JSON shape (replace example values with case-grounded values):\n${JSON.stringify(jsonExample)}`,
          }],
        }, { signal: input.signal }), `${phase.toLowerCase()} JSON retry prompt`);
        try {
          return { value: schema.parse(extractStructuredOutput(retryMessage)), sessionId: retry.id };
        } catch (retryError) {
          const third = retryError instanceof Error ? retryError.message : String(retryError);
          throw new Error(`${phase} JSON-object output failed first (${second}) and through its one bounded retry (${third}).`);
        }
      }
      if (nativeError !== undefined) {
        const first = nativeError instanceof Error ? nativeError.message : String(nativeError);
        throw new Error(`${phase} structured output failed natively (${first}) and through its one JSON fallback (${second}).`);
      }
      throw new Error(`${phase} JSON-object output failed (${second}).`);
    }
  }

  private async waitForResearchCompletion(client: ReturnType<typeof createOpencodeClient>, sessionId: string, input: ControllerInput, phaseDeadline: Date): Promise<boolean> {
    let observedBusy = false;
    let continuationPending = false;
    let emptyFrontierContinuationUsed = false;
    let continuationCount = 0;
    const startedAt = Date.now();
    while (Date.now() < phaseDeadline.getTime()) {
      if (input.signal.aborted) throw new DOMException("Investigation aborted", "AbortError");
      const statuses = unwrap(await client.session.status({ directory }), "session status");
      const status = statuses[sessionId]?.type;
      if (status === "busy" || status === "retry") {
        observedBusy = true;
        continuationPending = false;
      }
      const [frontier] = await getSql()<Array<{ totalCount: number; activeCount: number }>>`
        SELECT count(*)::integer AS "totalCount",
          count(*) FILTER (WHERE status IN ('OPEN', 'IN_PROGRESS'))::integer AS "activeCount"
        FROM research_questions
        WHERE investigation_id = ${input.investigationId} AND run_id = ${input.runId}
      `;
      const activeCount = frontier?.activeCount ?? 0;
      if (!researchContinuationAllowed({ continuationCount, activeQuestionCount: activeCount, durableProgress: true }) && activeCount > 0) {
        await client.session.abort({ sessionID: sessionId, directory }).catch(() => undefined);
        await insertAgentEvent({
          investigationId: input.investigationId,
          runId: input.runId,
          phase: "RESEARCH",
          agent: "runner",
          sessionId,
          eventType: "RESEARCH_CONTINUATION_EXHAUSTED",
          status: "COMPLETED",
          publicRationale: "The lead remained active after one bounded continuation; its session was stopped and the durable frontier will be reconciled before critic review.",
          payload: { activeQuestionCount: activeCount, continuationCount },
        });
        return true;
      }
      const action = researchCompletionAction({
        totalQuestionCount: frontier?.totalCount ?? 0,
        activeQuestionCount: activeCount,
        sessionStatus: status,
        readyForContinuation: !continuationPending && (observedBusy || Date.now() - startedAt >= 3_000),
      });
      if (action === "FINISH" || action === "ABORT_AND_FINISH") {
        if (action === "ABORT_AND_FINISH") {
          await client.session.abort({ sessionID: sessionId, directory });
          await insertAgentEvent({
            investigationId: input.investigationId,
            runId: input.runId,
            phase: "RESEARCH",
            agent: "runner",
            sessionId,
            eventType: "TERMINAL_FRONTIER_SESSION_ABORTED",
            status: "COMPLETED",
            publicRationale: "The durable Research Frontier was terminal, so the still-busy lead session was stopped and finalization began immediately.",
            payload: {},
          });
        }
        return true;
      }
      if (action !== "CONTINUE") {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      const emptyFrontier = (frontier?.totalCount ?? 0) === 0;
      if (emptyFrontier && emptyFrontierContinuationUsed) {
        throw new Error("LEAD_INTAKE_EMPTY: the lead ended twice without creating durable claims or research questions.");
      }
      const messages = unwrap(await client.session.messages({ sessionID: sessionId, directory, limit: 2 }), "session messages");
      const latest = messages.at(-1);
      if (latest?.info.role === "assistant" && latest.info.error) throw new Error(`OpenCode session failed: ${latest.info.error.name}`);
      await insertAgentEvent({
        investigationId: input.investigationId,
        runId: input.runId,
        phase: "RESEARCH",
        agent: "runner",
        sessionId,
        eventType: "RESEARCH_FRONTIER_CONTINUATION",
        status: "IN_PROGRESS",
        publicRationale: emptyFrontier
          ? "The lead ended before persisting intake state, so the same session received one bounded opportunity to complete claim decomposition and open the Research Frontier."
          : "The lead became idle while durable research questions remained active, so the same session was asked to finish or exhaust them before review.",
        payload: { activeQuestionCount: activeCount, emptyFrontier },
      });
      if (emptyFrontier) emptyFrontierContinuationUsed = true;
      else continuationCount += 1;
      await client.session.promptAsync({
        sessionID: sessionId,
        directory,
        agent: "lead-investigator",
        model: { providerID: "translucid", modelID: getConfig().researchModel },
        variant: getConfig().reasoningVariant,
        parts: [{
          type: "text",
          text: emptyFrontier
            ? "Your previous turn ended before creating any durable claims or research questions. Resume the ordered intake now without repeating completed file reads: persist the full claim coverage audit, open the compact Research Frontier, and proceed with the bounded research workflow. This is the only empty-intake continuation; do not return before durable intake state exists."
            : `The durable Research Frontier still has ${activeCount} active question(s). Continue only the evidence-justified work needed to resolve, exhaust, or skip each one. Do not start a third wave. Return as soon as the frontier is terminal.`,
        }],
      }, { signal: input.signal });
      continuationPending = true;
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
