import { z } from "zod";

import { getSql } from "../db/client.ts";
import { insertAgentEvent } from "../db/investigations.ts";
import { toolNames } from "../providers/contracts.ts";
import { claimFacetsSchema } from "../core/contracts.ts";
import {
  addEntityIdentifier,
  authorizeResearchTask,
  beginResearchWave,
  captureEvidence,
  createClaim,
  completeResearchTask,
  getArtifactExcerpts,
  getEntityGraph,
  getResearchContext,
  linkEntities,
  linkEvidence,
  listResearchQuestions,
  listTimeline,
  openResearchQuestion,
  recordObservation,
  resolveResearchQuestion,
  selectResearchRoute,
  updateClaimFacets,
  updateResearchQuestion,
  upsertEntity,
} from "../db/state.ts";

export const stateToolNames = [
  "claim.create", "claim.update_facets", "entity.upsert", "entity.add_identifier", "entity.link", "entity.get_graph",
  "observation.record", "observation.list_timeline", "research.open", "research.select_route",
  "research.update", "research.resolve", "research.list", "research.context", "research.begin_wave", "research.authorize_task", "research.complete_task",
  "artifact.excerpts",
  "evidence.capture", "evidence.link", "case_note", "capabilities.list",
] as const;

export type StateToolName = (typeof stateToolNames)[number];

const uuid = z.uuid();
const schemas: Record<StateToolName, z.ZodType> = {
  "claim.create": z.object({ category: z.string().min(1).max(100), normalizedClaim: z.string().min(1).max(4_000), materiality: z.enum(["HIGH", "MEDIUM", "LOW"]), facets: claimFacetsSchema, sourceSpan: z.record(z.string(), z.unknown()).optional() }).strict(),
  "claim.update_facets": z.object({ claimId: uuid, facets: claimFacetsSchema }).strict(),
  "entity.upsert": z.object({ type: z.enum(["PERSON", "ORGANIZATION", "ACCOUNT", "WEBSITE", "PUBLICATION", "PATENT", "PACKAGE"]), canonicalName: z.string().min(1).max(500), role: z.enum(["CANDIDATE_ROOT", "EXTERNAL"]), metadata: z.record(z.string(), z.unknown()).optional() }).strict(),
  "entity.add_identifier": z.object({ entityId: uuid, type: z.string().min(1).max(100), value: z.string().min(1).max(1_000), confidence: z.number().min(0).max(1), evidenceId: uuid }).strict(),
  "entity.link": z.object({ fromEntityId: uuid, toEntityId: uuid, relationship: z.string().min(1).max(100), anchors: z.array(z.object({ type: z.enum(["EMPLOYER_OVERLAP", "VERIFIED_DOMAIN", "CROSS_LINKED_ACCOUNT", "LOCATION_HISTORY", "REPOSITORY_IDENTITY", "AUTHORED_PAGE"]), evidenceId: uuid }).strict()).min(2).max(20) }).strict(),
  "entity.get_graph": z.object({}).strict(),
  "observation.record": z.object({ artifactId: uuid, entityId: uuid, field: z.string().min(1).max(200), valueJson: z.unknown(), sourceEventAt: z.iso.datetime().optional(), validFrom: z.iso.datetime().optional(), validTo: z.iso.datetime().optional() }).strict(),
  "observation.list_timeline": z.object({ entityId: uuid.optional() }).strict(),
  "research.open": z.object({ claimIds: z.array(uuid).max(100), question: z.string().min(5).max(2_000), priority: z.enum(["HIGH", "MEDIUM", "LOW"]), possibleRoutes: z.array(z.enum(toolNames)).min(1).max(20) }).strict(),
  "research.select_route": z.object({ questionId: uuid, route: z.string().min(1).max(200), publicRationale: z.string().min(10).max(500) }).strict(),
  "research.update": z.object({ questionId: uuid, priority: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(), possibleRoutes: z.array(z.enum(toolNames)).min(1).max(20).optional(), status: z.enum(["OPEN", "IN_PROGRESS"]).optional(), publicRationale: z.string().min(10).max(500) }).strict().refine((value) => Boolean(value.priority || value.possibleRoutes || value.status), "A research question update is required."),
  "research.resolve": z.object({ questionId: uuid, status: z.enum(["RESOLVED", "EXHAUSTED", "SKIPPED"]), resolutionSummary: z.string().min(5).max(2_000) }).strict(),
  "research.list": z.object({}).strict(),
  "research.context": z.object({ questionIds: z.array(uuid).min(1).max(12), maxBytes: z.number().int().min(128 * 1024).max(512 * 1024).optional() }).strict(),
  "artifact.excerpts": z.object({ artifactId: uuid, queries: z.array(z.string().trim().min(1).max(500)).min(1).max(12), maxExcerpts: z.number().int().min(1).max(12).optional(), maxCharacters: z.number().int().min(1).max(300_000).optional() }).strict(),
  "research.begin_wave": z.object({ waveKind: z.enum(["INITIAL", "TARGETED"]), questionIds: z.array(uuid).min(1).max(12), escalationReason: z.enum(["MATERIAL_CONTRADICTION", "IDENTITY_AMBIGUITY", "CHRONOLOGY_CONFLICT", "NEW_EVIDENCE_FAMILY", "MATERIAL_UNCERTAINTY"]).optional(), publicRationale: z.string().min(10).max(500) }).strict().refine((value) => value.waveKind === "INITIAL" || Boolean(value.escalationReason), "A targeted wave requires an escalation reason."),
  "research.authorize_task": z.object({ role: z.enum(["professional-investigator", "github-investigator", "web-records-investigator", "social-investigator"]) }).strict(),
  "research.complete_task": z.object({ role: z.enum(["professional-investigator", "github-investigator", "web-records-investigator", "social-investigator"]) }).strict(),
  "evidence.capture": z.object({ artifactId: uuid, exactQuote: z.string().min(1).max(12_000), sourceLocation: z.record(z.string(), z.unknown()).optional(), relation: z.enum(["SUPPORTS", "CONTRADICTS", "CONTEXT"]), claimIds: z.array(uuid).max(100), facetKeys: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(12), entityIds: z.array(uuid).max(100) }).strict().superRefine((value, context) => { if (value.relation !== "CONTEXT" && value.claimIds.length !== 1) context.addIssue({ code: "custom", message: `${value.relation} evidence must reference exactly one claim.` }); if (value.relation !== "CONTEXT" && value.facetKeys.length < 1) context.addIssue({ code: "custom", message: `${value.relation} evidence must reference at least one declared claim facet.` }); }),
  "evidence.link": z.object({ evidenceId: uuid, claimIds: z.array(uuid).max(0), entityIds: z.array(uuid).max(100) }).strict().refine((value) => value.entityIds.length > 0, "An entity link is required."),
  "case_note": z.object({ phase: z.string().min(1).max(100), status: z.string().min(1).max(100), publicRationale: z.string().min(10).max(500) }).strict(),
  "capabilities.list": z.object({}).strict(),
};

type OperationalContext = { investigationId: string; runId: string; agent: string; sessionId: string };

function date(value: unknown): Date | undefined {
  return typeof value === "string" ? new Date(value) : undefined;
}

export function isStateTool(name: string): name is StateToolName {
  return stateToolNames.includes(name as StateToolName);
}

export async function executeStateTool(name: StateToolName, raw: unknown, context: OperationalContext): Promise<unknown> {
  const args = schemas[name].parse(raw) as Record<string, unknown>;
  const base = { investigationId: context.investigationId, runId: context.runId };
  switch (name) {
    case "claim.create":
      return createClaim({ ...base, category: String(args.category), normalizedClaim: String(args.normalizedClaim), materiality: args.materiality as "HIGH" | "MEDIUM" | "LOW", facets: args.facets as Array<{ key: string; label: string; materiality: "HIGH" | "MEDIUM" | "LOW" }>, sourceSpan: args.sourceSpan as Record<string, unknown> | undefined, agent: context.agent, sessionId: context.sessionId });
    case "claim.update_facets":
      return updateClaimFacets({ ...base, claimId: String(args.claimId), facets: args.facets as Array<{ key: string; label: string; materiality: "HIGH" | "MEDIUM" | "LOW" }>, agent: context.agent, sessionId: context.sessionId });
    case "entity.upsert":
      return upsertEntity({ ...base, type: args.type as "PERSON" | "ORGANIZATION" | "ACCOUNT" | "WEBSITE" | "PUBLICATION" | "PATENT" | "PACKAGE", canonicalName: String(args.canonicalName), role: args.role as "CANDIDATE_ROOT" | "EXTERNAL", agent: context.agent, metadata: args.metadata as Record<string, unknown> | undefined });
    case "entity.add_identifier":
      return addEntityIdentifier({ ...base, entityId: String(args.entityId), type: String(args.type), value: String(args.value), confidence: Number(args.confidence), evidenceId: String(args.evidenceId) });
    case "entity.link":
      return linkEntities({ ...base, fromEntityId: String(args.fromEntityId), toEntityId: String(args.toEntityId), relationship: String(args.relationship), anchors: args.anchors as Array<{ type: "EMPLOYER_OVERLAP" | "VERIFIED_DOMAIN" | "CROSS_LINKED_ACCOUNT" | "LOCATION_HISTORY" | "REPOSITORY_IDENTITY" | "AUTHORED_PAGE"; evidenceId: string }>, agent: context.agent, sessionId: context.sessionId });
    case "entity.get_graph":
      return getEntityGraph(context.investigationId, context.runId);
    case "observation.record":
      return recordObservation({ ...base, artifactId: String(args.artifactId), entityId: String(args.entityId), field: String(args.field), value: args.valueJson, sourceEventAt: date(args.sourceEventAt), validFrom: date(args.validFrom), validTo: date(args.validTo) });
    case "observation.list_timeline":
      return listTimeline(context.investigationId, context.runId, typeof args.entityId === "string" ? args.entityId : undefined);
    case "research.open":
      return openResearchQuestion({ ...base, claimIds: args.claimIds as string[], question: String(args.question), priority: args.priority as "HIGH" | "MEDIUM" | "LOW", possibleRoutes: args.possibleRoutes as string[], createdByAgent: context.agent, createdBySession: context.sessionId });
    case "research.select_route": {
      const result = await selectResearchRoute({ ...base, questionId: String(args.questionId), route: String(args.route) });
      await insertAgentEvent({ ...base, phase: "RESEARCH", agent: context.agent, sessionId: context.sessionId, eventType: "RESEARCH_ROUTE_SELECTED", status: "IN_PROGRESS", publicRationale: String(args.publicRationale), payload: { questionId: args.questionId, route: args.route } });
      return result;
    }
    case "research.update": {
      const result = await updateResearchQuestion({ ...base, questionId: String(args.questionId), priority: args.priority as "HIGH" | "MEDIUM" | "LOW" | undefined, possibleRoutes: args.possibleRoutes as string[] | undefined, status: args.status as "OPEN" | "IN_PROGRESS" | undefined });
      await insertAgentEvent({ ...base, phase: "RESEARCH", agent: context.agent, sessionId: context.sessionId, eventType: "RESEARCH_QUESTION_UPDATED", status: String(result.status), publicRationale: String(args.publicRationale), payload: { questionId: args.questionId } });
      return result;
    }
    case "research.resolve": {
      const [question] = await getSql()<Array<{ selectedRoute: string | null }>>`SELECT selected_route AS "selectedRoute" FROM research_questions WHERE id = ${String(args.questionId)} AND investigation_id = ${context.investigationId}`;
      return resolveResearchQuestion({ ...base, questionId: String(args.questionId), selectedRoute: question?.selectedRoute ?? "NO_ROUTE", status: args.status as "RESOLVED" | "EXHAUSTED" | "SKIPPED", resolutionSummary: String(args.resolutionSummary) });
    }
    case "research.list":
      return listResearchQuestions(context.investigationId, context.runId);
    case "research.context":
      return getResearchContext(context.investigationId, context.runId, args.questionIds as string[], Number(args.maxBytes ?? 128 * 1024));
    case "artifact.excerpts":
      return getArtifactExcerpts(context.investigationId, context.runId, { artifactId: String(args.artifactId), queries: args.queries as string[], maxExcerpts: args.maxExcerpts as number | undefined, maxCharacters: args.maxCharacters as number | undefined });
    case "research.begin_wave": {
      const result = await beginResearchWave({ ...base, kind: args.waveKind as "INITIAL" | "TARGETED", questionIds: args.questionIds as string[], escalationReason: args.escalationReason as "MATERIAL_CONTRADICTION" | "IDENTITY_AMBIGUITY" | "CHRONOLOGY_CONFLICT" | "NEW_EVIDENCE_FAMILY" | "MATERIAL_UNCERTAINTY" | undefined, publicRationale: String(args.publicRationale), agent: context.agent, sessionId: context.sessionId });
      await insertAgentEvent({ ...base, phase: "RESEARCH", agent: context.agent, sessionId: context.sessionId, eventType: "RESEARCH_WAVE_STARTED", status: "IN_PROGRESS", publicRationale: String(args.publicRationale), payload: result });
      return result;
    }
    case "research.authorize_task":
      return authorizeResearchTask({ ...base, role: args.role as "professional-investigator" | "github-investigator" | "web-records-investigator" | "social-investigator", agent: context.agent, sessionId: context.sessionId });
    case "research.complete_task":
      return completeResearchTask({ ...base, role: args.role as "professional-investigator" | "github-investigator" | "web-records-investigator" | "social-investigator", agent: context.agent, sessionId: context.sessionId });
    case "evidence.capture":
      return captureEvidence({ ...base, artifactId: String(args.artifactId), exactQuote: String(args.exactQuote), sourceLocation: args.sourceLocation as Record<string, unknown> | undefined, relation: args.relation as "SUPPORTS" | "CONTRADICTS" | "CONTEXT", claimIds: args.claimIds as string[], facetKeys: args.facetKeys as string[], entityIds: args.entityIds as string[] });
    case "evidence.link":
      return linkEvidence({ ...base, evidenceId: String(args.evidenceId), claimIds: args.claimIds as string[], entityIds: args.entityIds as string[] });
    case "case_note":
      return insertAgentEvent({ ...base, phase: String(args.phase), agent: context.agent, sessionId: context.sessionId, eventType: "CASE_NOTE", status: String(args.status), publicRationale: String(args.publicRationale), payload: {} });
    case "capabilities.list": {
      const [run] = await getSql()<Array<{ capabilitySnapshot: unknown }>>`SELECT capability_snapshot AS "capabilitySnapshot" FROM runs WHERE id = ${context.runId} AND investigation_id = ${context.investigationId}`;
      if (!run) throw new Error("Run not found.");
      if (run.capabilitySnapshot === null) throw new Error("Runner capability snapshot is pending.");
      return run.capabilitySnapshot;
    }
  }
}
