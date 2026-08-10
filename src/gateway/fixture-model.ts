import { randomUUID } from "node:crypto";

import { getSql } from "../db/client.ts";

type Completion = { content?: string; toolCall?: { name: string; arguments: Record<string, unknown> } };

function toolNames(body: Record<string, unknown>): Set<string> {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return new Set(tools.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const fn = (item as { function?: unknown }).function;
    return fn && typeof fn === "object" && typeof (fn as { name?: unknown }).name === "string" ? [String((fn as { name: string }).name)] : [];
  }));
}

function latestUserText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const user = [...messages].reverse().find((message) => message && typeof message === "object" && (message as { role?: unknown }).role === "user") as { content?: unknown } | undefined;
  if (typeof user?.content === "string") return user.content;
  if (!Array.isArray(user?.content)) return "";
  return user.content.flatMap((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? [String((part as { text: string }).text)] : []).join("");
}

export async function fixtureCompletion(body: Record<string, unknown>, investigationId: string, runId: string): Promise<Completion> {
  const names = toolNames(body);
  const userText = latestUserText(body);
  const sql = getSql();
  const isStructured = body.tool_choice === "required" || names.has("StructuredOutput");
  const isCriticRequest = userText.includes("Audit this frozen durable bundle");
  const isFindingRequest = userText.includes("Adjudicate exactly these");
  const isSummaryRequest = userText.includes("Summarize only the validated findings");
  const isProfessionalFixture = userText.includes("Investigate the synthetic Acme chronology question");
  if (names.has("claim.create") && !isStructured && !isProfessionalFixture) {
    const [claims, entities, questions, providerCalls, evidence, observations, artifacts] = await Promise.all([
      sql<Array<{ id: string }>>`SELECT id FROM claims WHERE run_id = ${runId} ORDER BY created_at`,
      sql<Array<{ id: string }>>`SELECT id FROM entities WHERE run_id = ${runId} ORDER BY created_at`,
      sql<Array<{ id: string; status: string; selectedRoute: string | null }>>`SELECT id, status, selected_route AS "selectedRoute" FROM research_questions WHERE run_id = ${runId} ORDER BY created_at`,
      sql<Array<{ artifactIds: string[] }>>`SELECT artifact_ids AS "artifactIds" FROM provider_calls WHERE run_id = ${runId} ORDER BY created_at`,
      sql<Array<{ id: string }>>`SELECT id FROM evidence WHERE run_id = ${runId} ORDER BY created_at`,
      sql<Array<{ id: string }>>`SELECT id FROM observations WHERE run_id = ${runId} ORDER BY created_at`,
      sql<Array<{ id: string; provenance: Record<string, unknown> }>>`SELECT id, provenance FROM artifacts WHERE investigation_id = ${investigationId} ORDER BY created_at`,
    ]);
    if (!claims.length) return { toolCall: { name: "claim.create", arguments: { category: "EMPLOYMENT", normalizedClaim: "Synthetic Candidate held the title Principal Engineer at Acme Synthetic Labs from 2021 through 2025.", materiality: "HIGH", sourceSpan: { source: "synthetic fixture intake" } } } };
    if (!entities.length) return { toolCall: { name: "entity.upsert", arguments: { type: "PERSON", canonicalName: "Synthetic Candidate", metadata: { source: "synthetic fixture" } } } };
    if (!questions.length) return { toolCall: { name: "research.open", arguments: { claimIds: [claims[0]!.id], question: "Does synthetic public evidence corroborate the claimed Acme title chronology?", priority: "HIGH", possibleRoutes: ["web.search", "web.fetch"] } } };
    const question = questions[0]!;
    if (!question.selectedRoute) return { toolCall: { name: "research.select_route", arguments: { questionId: question.id, route: "web.search", publicRationale: "Starting with a low-cost public-web discovery route for the material chronology claim." } } };
    if (!providerCalls.length) return { toolCall: { name: "task", arguments: { description: "Check synthetic chronology", prompt: "Investigate the synthetic Acme chronology question. Use the selected web route, capture citable evidence and one temporal observation, resolve or exhaust the durable question, then return a concise public summary.", subagent_type: "professional-investigator", background: false } } };
    const citableArtifact = artifacts.find((artifact) => artifact.provenance.isSearchSnippet !== true && artifact.provenance.tool === "web.fetch");
    if (!citableArtifact) return { toolCall: { name: "web.fetch", arguments: { questionId: question.id, claimIds: [claims[0]!.id], publicRationale: "Capturing the discovered synthetic page before citing it.", url: "https://example.test/synthetic-source" } } };
    if (!evidence.length) return { toolCall: { name: "evidence.capture", arguments: { artifactId: citableArtifact.id, exactQuote: "Synthetic corroborating content for deterministic development tests.", sourceLocation: { jsonPath: "$.records[0].text" }, sourceTier: "SYNTHETIC_FIXTURE", relation: "SUPPORTS", claimIds: [claims[0]!.id], entityIds: [entities[0]!.id] } } };
    if (!observations.length) return { toolCall: { name: "observation.record", arguments: { artifactId: citableArtifact.id, entityId: entities[0]!.id, field: "employment", valueJson: { organization: "Acme Synthetic Labs", title: "Principal Engineer" }, validFrom: "2021-01-01T00:00:00.000Z", validTo: "2025-12-31T23:59:59.000Z" } } };
    if (question.status !== "RESOLVED") return { toolCall: { name: "research.resolve", arguments: { questionId: question.id, status: "RESOLVED", resolutionSummary: "The deterministic synthetic artifact corroborates the fixture chronology claim." } } };
    return { content: "The synthetic fixture frontier is complete. Durable claims, entity state, evidence, and observations are ready for frozen review." };
  }

  const [claims, evidence, entities, observations] = await Promise.all([
    sql<Array<{ id: string; normalizedClaim: string }>>`SELECT id, normalized_claim AS "normalizedClaim" FROM claims WHERE run_id = ${runId} ORDER BY created_at`,
    sql<Array<{ id: string; claimIds: string[]; relation: string }>>`SELECT id, claim_ids AS "claimIds", relation FROM evidence WHERE run_id = ${runId} ORDER BY created_at`,
    sql<Array<{ id: string }>>`SELECT id FROM entities WHERE run_id = ${runId} ORDER BY created_at`,
    sql<Array<{ id: string }>>`SELECT id FROM observations WHERE run_id = ${runId} ORDER BY created_at`,
  ]);
  if (isProfessionalFixture) {
    const [questions, providerCalls, artifacts] = await Promise.all([
      sql<Array<{ id: string; status: string }>>`SELECT id, status FROM research_questions WHERE run_id = ${runId} ORDER BY created_at`,
      sql<Array<{ artifactIds: string[] }>>`SELECT artifact_ids AS "artifactIds" FROM provider_calls WHERE run_id = ${runId} ORDER BY created_at`,
      sql<Array<{ id: string; provenance: Record<string, unknown> }>>`SELECT id, provenance FROM artifacts WHERE investigation_id = ${investigationId} ORDER BY created_at`,
    ]);
    const claim = claims[0];
    const entity = entities[0];
    const question = questions[0];
    if (!claim || !entity || !question) return { content: "The durable synthetic research state is incomplete, so this route is exhausted." };
    if (!providerCalls.length) return { toolCall: { name: "web.search", arguments: { questionId: question.id, claimIds: [claim.id], publicRationale: "Discovering a synthetic source for the material chronology claim.", query: "Synthetic Candidate Acme Synthetic Labs Principal Engineer", mode: "fast" } } };
    const citableArtifact = artifacts.find((artifact) => artifact.provenance.isSearchSnippet !== true && artifact.provenance.tool === "web.fetch");
    if (!citableArtifact) return { toolCall: { name: "web.fetch", arguments: { questionId: question.id, claimIds: [claim.id], publicRationale: "Capturing the discovered synthetic page before citing it.", url: "https://example.test/synthetic-source" } } };
    if (!evidence.length) return { toolCall: { name: "evidence.capture", arguments: { artifactId: citableArtifact.id, exactQuote: "Synthetic corroborating content for deterministic development tests.", sourceLocation: { jsonPath: "$.records[0].text" }, sourceTier: "SYNTHETIC_FIXTURE", relation: "SUPPORTS", claimIds: [claim.id], entityIds: [entity.id] } } };
    if (!observations.length) return { toolCall: { name: "observation.record", arguments: { artifactId: citableArtifact.id, entityId: entity.id, field: "employment", valueJson: { organization: "Acme Synthetic Labs", title: "Principal Engineer" }, validFrom: "2021-01-01T00:00:00.000Z", validTo: "2025-12-31T23:59:59.000Z" } } };
    if (question.status !== "RESOLVED") return { toolCall: { name: "research.resolve", arguments: { questionId: question.id, status: "RESOLVED", resolutionSummary: "The deterministic synthetic artifact corroborates the fixture chronology claim." } } };
    return { content: "The synthetic chronology route is complete with captured evidence and a temporal observation." };
  }
  if (isCriticRequest) {
    const audit = {
      acceptedEvidenceIds: evidence.map(({ id }) => id),
      rejectedEvidence: [],
      claimConcerns: [],
      identityConcerns: entities.length < 2 ? ["The synthetic fixture establishes a root person but no independently linked external account."] : [],
      chronologyConcerns: [],
      limitations: ["Synthetic fixture evidence is suitable only for development validation."],
    };
    return isStructured
      ? { toolCall: { name: "StructuredOutput", arguments: audit } }
      : { content: JSON.stringify(audit) };
  }
  const requestedClaims = isFindingRequest ? claims.filter(({ id }) => userText.includes(id)) : claims;
  const findings = requestedClaims.map((claim) => {
    const supporting = evidence.filter((item) => item.relation === "SUPPORTS" && item.claimIds.includes(claim.id)).map(({ id }) => id);
    return { claimId: claim.id, verdict: supporting.length ? "CORROBORATED" : "UNRESOLVED", strength: supporting.length ? "MODERATE" : "WEAK", explanation: supporting.length ? "The deterministic synthetic source directly supports this fixture claim." : "No saved synthetic evidence resolves this claim.", supportingEvidenceIds: supporting, contradictingEvidenceIds: [], limitations: ["This is a synthetic development result, not a real-world verification."] };
  });
  const summary = { professionalIdentity: { status: "AMBIGUOUS", summary: "The synthetic root person comes from intake; no external account was linked because the two-anchor threshold was not met.", evidenceIds: [] }, professionalTimelineSummary: observations.length ? "One synthetic employment observation records the Principal Engineer title at Acme Synthetic Labs for 2021–2025." : "No professional timeline observations were saved.", strongestEvidenceIds: evidence.map(({ id }) => id).slice(0, 3), materialInconsistencies: [], unresolvedMaterialClaimIds: claims.filter((claim) => !evidence.some((item) => item.claimIds.includes(claim.id))).map(({ id }) => id), investigationLimitations: ["All sources and identities in this run are deterministic synthetic fixtures."] };
  const focused = isFindingRequest ? { findings } : isSummaryRequest ? { summary } : { summary, findings };
  if (isStructured) return { toolCall: { name: "StructuredOutput", arguments: focused } };
  return { content: JSON.stringify(focused) };
}

export function writeFixtureCompletion(response: import("node:http").ServerResponse, body: Record<string, unknown>, model: string, completion: Completion): void {
  const id = `chatcmpl_fixture_${randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1_000);
  const message = completion.toolCall
    ? { role: "assistant", content: null, tool_calls: [{ id: `call_${randomUUID().replaceAll("-", "")}`, type: "function", function: { name: completion.toolCall.name, arguments: JSON.stringify(completion.toolCall.arguments) } }] }
    : { role: "assistant", content: completion.content ?? "" };
  if (body.stream === true) {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: completion.toolCall ? "tool_calls" : "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
    return;
  }
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ id, object: "chat.completion", created, model, choices: [{ index: 0, message, finish_reason: completion.toolCall ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }));
}
