import { z } from "zod";

import { getSql } from "../db/client.ts";
import { insertAgentEvent } from "../db/investigations.ts";
import {
  addEntityIdentifier,
  captureEvidence,
  createClaim,
  getEntityGraph,
  linkEntities,
  linkEvidence,
  listResearchQuestions,
  listTimeline,
  openResearchQuestion,
  recordObservation,
  resolveResearchQuestion,
  selectResearchRoute,
  updateResearchQuestion,
  upsertEntity,
} from "../db/state.ts";

export const stateToolNames = [
  "claim.create", "entity.upsert", "entity.add_identifier", "entity.link", "entity.get_graph",
  "observation.record", "observation.list_timeline", "research.open", "research.select_route",
  "research.update", "research.resolve", "research.list", "evidence.capture", "evidence.link", "case_note", "capabilities.list",
] as const;

export type StateToolName = (typeof stateToolNames)[number];

const uuid = z.uuid();
const schemas: Record<StateToolName, z.ZodType> = {
  "claim.create": z.object({ category: z.string().min(1).max(100), normalizedClaim: z.string().min(1).max(4_000), materiality: z.enum(["HIGH", "MEDIUM", "LOW"]), sourceSpan: z.record(z.string(), z.unknown()).optional() }).strict(),
  "entity.upsert": z.object({ type: z.enum(["PERSON", "ORGANIZATION", "ACCOUNT", "WEBSITE", "PUBLICATION", "PATENT", "PACKAGE"]), canonicalName: z.string().min(1).max(500), metadata: z.record(z.string(), z.unknown()).optional() }).strict(),
  "entity.add_identifier": z.object({ entityId: uuid, type: z.string().min(1).max(100), value: z.string().min(1).max(1_000), confidence: z.number().min(0).max(1), evidenceId: uuid }).strict(),
  "entity.link": z.object({ fromEntityId: uuid, toEntityId: uuid, relationship: z.string().min(1).max(100), anchors: z.array(z.object({ type: z.enum(["EMPLOYER_OVERLAP", "VERIFIED_DOMAIN", "CROSS_LINKED_ACCOUNT", "LOCATION_HISTORY", "REPOSITORY_IDENTITY", "AUTHORED_PAGE"]), evidenceId: uuid, sourceKey: z.string().min(1) }).strict()).min(2).max(20) }).strict(),
  "entity.get_graph": z.object({}).strict(),
  "observation.record": z.object({ artifactId: uuid, entityId: uuid, field: z.string().min(1).max(200), valueJson: z.unknown(), sourceEventAt: z.iso.datetime().optional(), validFrom: z.iso.datetime().optional(), validTo: z.iso.datetime().optional() }).strict(),
  "observation.list_timeline": z.object({ entityId: uuid.optional() }).strict(),
  "research.open": z.object({ claimIds: z.array(uuid).max(100), question: z.string().min(5).max(2_000), priority: z.enum(["HIGH", "MEDIUM", "LOW"]), possibleRoutes: z.array(z.string().min(1).max(200)).min(1).max(20) }).strict(),
  "research.select_route": z.object({ questionId: uuid, route: z.string().min(1).max(200), publicRationale: z.string().min(10).max(500) }).strict(),
  "research.update": z.object({ questionId: uuid, priority: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(), possibleRoutes: z.array(z.string().min(1).max(200)).min(1).max(20).optional(), status: z.enum(["OPEN", "IN_PROGRESS"]).optional(), publicRationale: z.string().min(10).max(500) }).strict().refine((value) => Boolean(value.priority || value.possibleRoutes || value.status), "A research question update is required."),
  "research.resolve": z.object({ questionId: uuid, status: z.enum(["RESOLVED", "EXHAUSTED", "SKIPPED"]), resolutionSummary: z.string().min(5).max(2_000) }).strict(),
  "research.list": z.object({}).strict(),
  "evidence.capture": z.object({ artifactId: uuid, exactQuote: z.string().min(1).max(12_000), sourceLocation: z.record(z.string(), z.unknown()).optional(), sourceTier: z.string().min(1).max(100), relation: z.enum(["SUPPORTS", "CONTRADICTS", "CONTEXT"]), claimIds: z.array(uuid).max(100), entityIds: z.array(uuid).max(100) }).strict(),
  "evidence.link": z.object({ evidenceId: uuid, claimIds: z.array(uuid).max(100), entityIds: z.array(uuid).max(100) }).strict().refine((value) => value.claimIds.length > 0 || value.entityIds.length > 0, "A claim or entity link is required."),
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
      return createClaim({ ...base, category: String(args.category), normalizedClaim: String(args.normalizedClaim), materiality: args.materiality as "HIGH" | "MEDIUM" | "LOW", sourceSpan: args.sourceSpan as Record<string, unknown> | undefined });
    case "entity.upsert":
      return upsertEntity({ ...base, type: args.type as "PERSON" | "ORGANIZATION" | "ACCOUNT" | "WEBSITE" | "PUBLICATION" | "PATENT" | "PACKAGE", canonicalName: String(args.canonicalName), metadata: args.metadata as Record<string, unknown> | undefined });
    case "entity.add_identifier":
      return addEntityIdentifier({ ...base, entityId: String(args.entityId), type: String(args.type), value: String(args.value), confidence: Number(args.confidence), evidenceId: String(args.evidenceId) });
    case "entity.link":
      return linkEntities({ ...base, fromEntityId: String(args.fromEntityId), toEntityId: String(args.toEntityId), relationship: String(args.relationship), anchors: args.anchors as Array<{ type: "EMPLOYER_OVERLAP" | "VERIFIED_DOMAIN" | "CROSS_LINKED_ACCOUNT" | "LOCATION_HISTORY" | "REPOSITORY_IDENTITY" | "AUTHORED_PAGE"; evidenceId: string; sourceKey: string }> });
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
    case "evidence.capture":
      return captureEvidence({ ...base, artifactId: String(args.artifactId), exactQuote: String(args.exactQuote), sourceLocation: args.sourceLocation as Record<string, unknown> | undefined, sourceTier: String(args.sourceTier), relation: args.relation as "SUPPORTS" | "CONTRADICTS" | "CONTEXT", claimIds: args.claimIds as string[], entityIds: args.entityIds as string[] });
    case "evidence.link":
      return linkEvidence({ ...base, evidenceId: String(args.evidenceId), claimIds: args.claimIds as string[], entityIds: args.entityIds as string[] });
    case "case_note":
      return insertAgentEvent({ ...base, phase: String(args.phase), agent: context.agent, sessionId: context.sessionId, eventType: "CASE_NOTE", status: String(args.status), publicRationale: String(args.publicRationale), payload: {} });
    case "capabilities.list": {
      const [run] = await getSql()<Array<{ capabilitySnapshot: unknown }>>`SELECT capability_snapshot AS "capabilitySnapshot" FROM runs WHERE id = ${context.runId} AND investigation_id = ${context.investigationId}`;
      if (!run) throw new Error("Run not found.");
      return run.capabilitySnapshot;
    }
  }
}
