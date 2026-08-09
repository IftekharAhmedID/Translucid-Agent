import {
  bigint,
  bigserial,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import type { InvestigationSummary } from "../core/contracts.ts";
import type { CapabilityRegistry } from "../core/capabilities.ts";

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const investigations = pgTable(
  "investigations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    status: text("status").notNull().default("QUEUED"),
    runtimeKind: text("runtime_kind").notNull(),
    dataClassification: text("data_classification").notNull().default("SYNTHETIC"),
    submissionKind: text("submission_kind").notNull(),
    submissionRaw: text("submission_raw").notNull(),
    submissionNormalized: text("submission_normalized").notNull(),
    submissionSha256: text("submission_sha256").notNull(),
    resumeArtifactId: uuid("resume_artifact_id"),
    latestRunId: uuid("latest_run_id"),
    finalSummary: jsonb("final_summary").$type<InvestigationSummary>(),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index("investigations_status_created_idx").on(table.status, table.createdAt)],
);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    investigationId: uuid("investigation_id")
      .notNull()
      .references(() => investigations.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("QUEUED"),
    attemptCount: integer("attempt_count").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    runtimeHandle: jsonb("runtime_handle").$type<Record<string, unknown>>(),
    openCodePrimarySessionId: text("opencode_primary_session_id"),
    openCodeAdjudicatorSessionId: text("opencode_adjudicator_session_id"),
    capabilitySnapshot: jsonb("capability_snapshot").$type<CapabilityRegistry>().notNull(),
    budgetCounters: jsonb("budget_counters").$type<Record<string, number>>().notNull(),
    runtimeManifestHash: text("runtime_manifest_hash"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    cleanupStatus: text("cleanup_status").notNull().default("PENDING"),
    queuedAt: timestamp("queued_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("runs_claim_idx").on(table.status, table.leaseExpiresAt, table.queuedAt),
    index("runs_investigation_idx").on(table.investigationId, table.createdAt),
  ],
);

export const claims = pgTable(
  "claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    investigationId: uuid("investigation_id").notNull().references(() => investigations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    normalizedClaim: text("normalized_claim").notNull(),
    materiality: text("materiality").notNull(),
    sourceSpan: jsonb("source_span").$type<Record<string, unknown>>(),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validTo: timestamp("valid_to", { withTimezone: true }),
    entityIds: uuid("entity_ids").array().notNull().default([]),
    status: text("status").notNull().default("OPEN"),
    ...timestamps,
  },
  (table) => [index("claims_case_idx").on(table.investigationId, table.materiality)],
);

export const entities = pgTable(
  "entities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    investigationId: uuid("investigation_id").notNull().references(() => investigations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    canonicalName: text("canonical_name").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    ...timestamps,
  },
  (table) => [index("entities_case_name_idx").on(table.investigationId, table.canonicalName)],
);

export const entityIdentifiers = pgTable(
  "entity_identifiers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    investigationId: uuid("investigation_id").notNull().references(() => investigations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id").notNull().references(() => entities.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    value: text("value").notNull(),
    normalizedValue: text("normalized_value").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    evidenceId: uuid("evidence_id"),
    ...timestamps,
  },
  (table) => [index("entity_identifiers_lookup_idx").on(table.investigationId, table.type, table.normalizedValue)],
);

export const entityLinks = pgTable(
  "entity_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    investigationId: uuid("investigation_id").notNull().references(() => investigations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    fromEntityId: uuid("from_entity_id").notNull().references(() => entities.id, { onDelete: "cascade" }),
    toEntityId: uuid("to_entity_id").notNull().references(() => entities.id, { onDelete: "cascade" }),
    relationship: text("relationship").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    evidenceIds: uuid("evidence_ids").array().notNull(),
    ...timestamps,
  },
  (table) => [index("entity_links_case_idx").on(table.investigationId, table.fromEntityId)],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    investigationId: uuid("investigation_id").notNull().references(() => investigations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    provider: text("provider"),
    sourceUrl: text("source_url"),
    mimeType: text("mime_type").notNull(),
    fileName: text("file_name"),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).defaultNow().notNull(),
    httpMetadata: jsonb("http_metadata").$type<Record<string, unknown>>().notNull(),
    sha256: text("sha256").notNull(),
    byteLength: bigint("byte_length", { mode: "number" }).notNull(),
    contentBytes: bytea("content_bytes").notNull(),
    provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("artifacts_case_idx").on(table.investigationId, table.createdAt)],
);

export const observations = pgTable(
  "observations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    investigationId: uuid("investigation_id").notNull().references(() => investigations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    artifactId: uuid("artifact_id").notNull().references(() => artifacts.id),
    entityId: uuid("entity_id").notNull().references(() => entities.id, { onDelete: "cascade" }),
    field: text("field").notNull(),
    valueJson: jsonb("value_json").$type<unknown>().notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).defaultNow().notNull(),
    sourceEventAt: timestamp("source_event_at", { withTimezone: true }),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validTo: timestamp("valid_to", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("observations_timeline_idx").on(table.investigationId, table.entityId, table.validFrom)],
);

export const evidence = pgTable(
  "evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    investigationId: uuid("investigation_id").notNull().references(() => investigations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    artifactId: uuid("artifact_id").notNull().references(() => artifacts.id),
    exactQuote: text("exact_quote").notNull(),
    sourceLocation: jsonb("source_location").$type<Record<string, unknown>>().notNull(),
    sourceTier: text("source_tier").notNull(),
    relation: text("relation").notNull(),
    claimIds: uuid("claim_ids").array().notNull(),
    entityIds: uuid("entity_ids").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("evidence_case_idx").on(table.investigationId, table.createdAt)],
);

export const researchQuestions = pgTable(
  "research_questions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    investigationId: uuid("investigation_id").notNull().references(() => investigations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    claimIds: uuid("claim_ids").array().notNull(),
    question: text("question").notNull(),
    priority: text("priority").notNull(),
    status: text("status").notNull().default("OPEN"),
    possibleRoutes: jsonb("possible_routes").$type<string[]>().notNull(),
    selectedRoute: text("selected_route"),
    createdByAgent: text("created_by_agent").notNull(),
    createdBySession: text("created_by_session"),
    resolutionSummary: text("resolution_summary"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index("research_frontier_idx").on(table.investigationId, table.status, table.priority)],
);

export const findings = pgTable(
  "findings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    investigationId: uuid("investigation_id").notNull().references(() => investigations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    claimId: uuid("claim_id").notNull().references(() => claims.id, { onDelete: "cascade" }),
    verdict: text("verdict").notNull(),
    strength: text("strength").notNull(),
    explanation: text("explanation").notNull(),
    supportingEvidenceIds: uuid("supporting_evidence_ids").array().notNull(),
    contradictingEvidenceIds: uuid("contradicting_evidence_ids").array().notNull(),
    limitations: text("limitations").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("findings_case_idx").on(table.investigationId, table.claimId)],
);

export const agentEvents = pgTable(
  "agent_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    investigationId: uuid("investigation_id").notNull().references(() => investigations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    phase: text("phase").notNull(),
    agent: text("agent").notNull(),
    sessionId: text("session_id"),
    eventType: text("event_type").notNull(),
    tool: text("tool"),
    source: text("source"),
    status: text("status").notNull(),
    budgetDelta: jsonb("budget_delta").$type<Record<string, number>>().notNull(),
    publicRationale: text("public_rationale"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("agent_events_stream_idx").on(table.investigationId, table.id)],
);

export const providerCalls = pgTable(
  "provider_calls",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    investigationId: uuid("investigation_id").notNull().references(() => investigations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
    provider: text("provider").notNull(),
    requestMetadata: jsonb("request_metadata").$type<Record<string, unknown>>().notNull(),
    latencyMs: integer("latency_ms").notNull(),
    resultStatus: text("result_status").notNull(),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    retryAfterMs: integer("retry_after_ms"),
    artifactIds: uuid("artifact_ids").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("provider_calls_budget_idx").on(table.investigationId, table.provider, table.createdAt)],
);

export const caseTables = [
  investigations,
  runs,
  claims,
  entities,
  entityIdentifiers,
  entityLinks,
  artifacts,
  observations,
  evidence,
  researchQuestions,
  findings,
  agentEvents,
  providerCalls,
];
