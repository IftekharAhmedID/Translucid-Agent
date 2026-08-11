import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

import { childTaskEnvelope, needsChildHandoffContinuation, publicAssistantText } from "./child-handoff.ts";

const z = tool.schema;
const gatewayUrl = process.env.CASE_GATEWAY_URL;
const token = process.env.CASE_TOKEN;
const investigationId = process.env.INVESTIGATION_ID;
const runId = process.env.RUN_ID;
const taskAssignments = new Map<string, string>();

if (!gatewayUrl || !token || !investigationId || !runId) {
  throw new Error("Case-scoped gateway environment is incomplete.");
}

async function execute(toolName: string, args: unknown, context: { sessionID: string; agent: string; abort: AbortSignal }) {
  const response = await fetch(`${gatewayUrl}/internal/tools/execute`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-investigation-id": investigationId,
      "x-run-id": runId,
    },
    body: JSON.stringify({
      tool: toolName,
      arguments: args,
      operational: { sessionId: context.sessionID, agent: context.agent },
    }),
    signal: context.abort,
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Gateway rejected ${toolName} (${response.status}): ${body.slice(0, 300)}`);
  return body;
}

const common = {
  questionId: z.string().uuid().describe("Durable research question ID"),
  claimIds: z.array(z.string().uuid()).describe("Claims affected by this operation"),
  publicRationale: z.string().min(10).max(500).describe("Concise rationale safe to show in Agent Trace"),
};

const researchRoute = z.enum([
  "web.search", "web.fetch", "professional.profile", "professional.activity",
  "social.profile", "github.graphql", "github.rest", "github.clone",
  "archives.search", "public_records.search", "scholarly.search",
  "packages.inspect", "security_records.search",
]);

function gatewayTool(name: string, description: string, args: Record<string, ReturnType<typeof z.string> | ReturnType<typeof z.array> | ReturnType<typeof z.enum> | ReturnType<typeof z.record> | ReturnType<typeof z.number> | ReturnType<typeof z.any>>) {
  return tool({ description, args, async execute(values, context) { return execute(name, values, context); } });
}

const plugin: Plugin = async ({ client }) => ({
  "chat.headers": async (input, output) => {
    output.headers["x-investigation-id"] = investigationId;
    output.headers["x-run-id"] = runId;
    output.headers["x-opencode-agent"] = input.agent;
  },
  tool: {
    "web.search": gatewayTool("web.search", "Discover public web sources and capture returned inline contents separately from non-citable discovery metadata.", { ...common, query: z.string().min(2).max(1000), mode: z.enum(["fast", "auto"]).default("fast"), highlightQuery: z.string().min(2).max(1000).optional(), resultLimit: z.number().int().min(1).max(10).default(5) }),
    "web.fetch": gatewayTool("web.fetch", "Capture a public page as an immutable artifact before creating evidence.", { ...common, url: z.string().url() }),
    "professional.profile": gatewayTool("professional.profile", "Retrieve professional profile data with code-enforced LinkdAPI then one conditional Bright Data fallback for the exact missing material field.", { ...common, username: z.string().min(2).max(200), requiredMaterialField: z.enum(["IDENTITY", "CURRENT_POSITION", "EMPLOYMENT_HISTORY", "EDUCATION"]).default("IDENTITY") }),
    "professional.activity": gatewayTool("professional.activity", "Retrieve professional activity only when a claim requires it.", { ...common, username: z.string().min(2).max(200) }),
    "social.profile": gatewayTool("social.profile", "Retrieve a public social profile only for an allowed material reason.", { ...common, platform: z.enum(["X", "INSTAGRAM", "TIKTOK"]), handle: z.string().min(1).max(200), reason: z.enum(["EXPLICIT_SOCIAL_CLAIM", "PUBLIC_IDENTITY_CROSS_LINK", "MATERIAL_ACTIVITY_QUESTION"]) }),
    "github.graphql": gatewayTool("github.graphql", "Query public GitHub contribution records using authenticated GraphQL.", { ...common, query: z.string().min(1).max(20000), variables: z.record(z.string(), z.any()).default({}) }),
    "github.rest": gatewayTool("github.rest", "Read an allowlisted public GitHub REST resource.", { ...common, path: z.string().min(2).max(1000) }),
    "github.clone": gatewayTool("github.clone", "Clone one relevant public GitHub repository through the host's restricted, budgeted wrapper and inspect bounded history and patch excerpts.", { ...common, repository: z.string().min(3).max(201), ref: z.string().max(200).optional(), authorHint: z.string().max(200).optional() }),
    "archives.search": gatewayTool("archives.search", "Find dated Wayback or Common Crawl captures.", { ...common, url: z.string().url(), fromYear: z.number().int().min(1996).max(2100).optional(), toYear: z.number().int().min(1996).max(2100).optional() }),
    "public_records.search": gatewayTool("public_records.search", "Search a specific patent, SEC, or IETF public-record source.", { ...common, recordType: z.enum(["PATENT", "SEC", "IETF"]), query: z.string().min(2).max(1000) }),
    "scholarly.search": gatewayTool("scholarly.search", "Find scholarly works through OpenAlex or Crossref.", { ...common, query: z.string().min(2).max(1000) }),
    "packages.inspect": gatewayTool("packages.inspect", "Inspect public package metadata and repository links.", { ...common, registry: z.enum(["NPM", "PYPI", "HUGGING_FACE"]), package: z.string().min(1).max(300) }),
    "security_records.search": gatewayTool("security_records.search", "Search OSV, GitHub advisory, or NVD public vulnerability records.", { ...common, ecosystem: z.string().max(100).optional(), package: z.string().max(300).optional(), cve: z.string().max(40).optional() }),
    "claim.create": gatewayTool("claim.create", "Persist one coherent verification unit with predeclared facets. Do not create derived duration, generic skill, contact, or identity-anchor claims.", { category: z.string().min(1).max(100), normalizedClaim: z.string().min(1).max(4000), materiality: z.enum(["HIGH", "MEDIUM", "LOW"]), facets: z.array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), label: z.string().min(1).max(300), materiality: z.enum(["HIGH", "MEDIUM", "LOW"]) })).min(1).max(12), sourceSpan: z.record(z.string(), z.any()).optional() }),
    "claim.update_facets": gatewayTool("claim.update_facets", "Replace one complete claim facet declaration before the initial research wave. Lead-only.", { claimId: z.string().uuid(), facets: z.array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), label: z.string().min(1).max(300), materiality: z.enum(["HIGH", "MEDIUM", "LOW"]) })).min(1).max(12) }),
    "entity.upsert": gatewayTool("entity.upsert", "Create or update a distinct entity. Only the lead may assign CANDIDATE_ROOT; every external account or record starts as EXTERNAL.", { type: z.enum(["PERSON", "ORGANIZATION", "ACCOUNT", "WEBSITE", "PUBLICATION", "PATENT", "PACKAGE"]), canonicalName: z.string().min(1).max(500), role: z.enum(["CANDIDATE_ROOT", "EXTERNAL"]), metadata: z.record(z.string(), z.any()).optional() }),
    "entity.add_identifier": gatewayTool("entity.add_identifier", "Add an evidence-backed normalized identifier.", { entityId: z.string().uuid(), type: z.string().min(1).max(100), value: z.string().min(1).max(1000), confidence: z.number().min(0).max(1), evidenceId: z.string().uuid() }),
    "entity.link": gatewayTool("entity.link", "Link entities only with two distinct anchor types whose evidence belongs to backend-verified independent source families.", { fromEntityId: z.string().uuid(), toEntityId: z.string().uuid(), relationship: z.string().min(1).max(100), anchors: z.array(z.object({ type: z.enum(["EMPLOYER_OVERLAP", "VERIFIED_DOMAIN", "CROSS_LINKED_ACCOUNT", "LOCATION_HISTORY", "REPOSITORY_IDENTITY", "AUTHORED_PAGE"]), evidenceId: z.string().uuid() })).min(2).max(20) }),
    "entity.get_graph": gatewayTool("entity.get_graph", "Read the durable entity graph.", {}),
    "observation.record": gatewayTool("observation.record", "Record a temporal observation from a captured artifact.", { artifactId: z.string().uuid(), entityId: z.string().uuid(), field: z.string().min(1).max(200), valueJson: z.any(), sourceEventAt: z.string().datetime().optional(), validFrom: z.string().datetime().optional(), validTo: z.string().datetime().optional() }),
    "observation.list_timeline": gatewayTool("observation.list_timeline", "Read the data-backed timeline without collapsing conflicts.", { entityId: z.string().uuid().optional() }),
    "research.open": gatewayTool("research.open", "Open a durable research question before using an expensive tool. possibleRoutes must be exact semantic tool IDs.", { claimIds: z.array(z.string().uuid()).max(100), question: z.string().min(5).max(2000), priority: z.enum(["HIGH", "MEDIUM", "LOW"]), possibleRoutes: z.array(researchRoute).min(1).max(20) }),
    "research.select_route": gatewayTool("research.select_route", "Select a route using exactly one semantic tool ID already stored in possibleRoutes.", { questionId: z.string().uuid(), route: researchRoute, publicRationale: z.string().min(10).max(500) }),
    "research.update": gatewayTool("research.update", "Update an open durable question. possibleRoutes must be exact semantic tool IDs.", { questionId: z.string().uuid(), priority: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(), possibleRoutes: z.array(researchRoute).min(1).max(20).optional(), status: z.enum(["OPEN", "IN_PROGRESS"]).optional(), publicRationale: z.string().min(10).max(500) }),
    "research.resolve": gatewayTool("research.resolve", "Resolve, exhaust, or skip a durable research question. EXHAUSTED requires evidence capture or explicit review of every successful citable artifact.", { questionId: z.string().uuid(), status: z.enum(["RESOLVED", "EXHAUSTED", "SKIPPED"]), resolutionSummary: z.string().min(5).max(2000), reviewedArtifactIds: z.array(z.string().uuid()).max(100).optional() }),
    "research.list": gatewayTool("research.list", "Read the current durable research frontier.", {}),
    "research.context": gatewayTool("research.context", "Read deterministic question-scoped case memory, including the assigned claims, exact declared facets, facet gaps, relevant artifacts, evidence, and provider attempts. This is read-only, bounded, and excludes provider secrets and raw payloads.", { questionIds: z.array(z.string().uuid()).min(1).max(12), maxBytes: z.number().int().min(128 * 1024).max(512 * 1024).optional() }),
    "artifact.excerpts": gatewayTool("artifact.excerpts", "Search an immutable stored provider artifact locally for exact JSON scalar paths or bounded text windows, without a refetch or provider call.", { artifactId: z.string().uuid(), queries: z.array(z.string().min(1).max(500)).min(1).max(12), maxExcerpts: z.number().int().min(1).max(12).optional(), maxCharacters: z.number().int().min(1).max(300000).optional() }),
    "artifact.lookup": gatewayTool("artifact.lookup", "List immutable provider artifacts already captured for assigned questions or a source route. PostgreSQL-only metadata lookup; it never refetches and never returns artifact bodies.", { questionIds: z.array(z.string().uuid()).min(1).max(12).optional(), sourceUrl: z.string().url().optional(), providerRoute: z.string().min(1).max(200).optional(), kind: z.string().min(1).max(100).optional() }),
    "research.begin_wave": gatewayTool("research.begin_wave", "Begin the initial research wave or one evidence-justified targeted second wave before native task delegation.", { waveKind: z.enum(["INITIAL", "TARGETED"]), questionIds: z.array(z.string().uuid()).min(1).max(12), escalationReason: z.enum(["MATERIAL_CONTRADICTION", "IDENTITY_AMBIGUITY", "CHRONOLOGY_CONFLICT", "NEW_EVIDENCE_FAMILY", "MATERIAL_UNCERTAINTY"]).optional(), publicRationale: z.string().min(10).max(500) }),
    "evidence.capture": gatewayTool("evidence.capture", "Create one facet-aligned evidence edge from exact text stored in an immutable non-snippet artifact. For JSON, exactQuote must be a scalar or bounded excerpt returned by artifact.excerpts, not reconstructed JSON or a key/value serialization. SUPPORTS and CONTRADICTS each require exactly one claim and one or more declared facet keys copied verbatim from that claim's latest research.context facets; never invent synonym keys. CONTEXT may have zero or more claim associations and is never citation-eligible. Source authority is assigned by the gateway.", { artifactId: z.string().uuid(), exactQuote: z.string().min(1).max(12000), sourceLocation: z.record(z.string(), z.any()).optional(), relation: z.enum(["SUPPORTS", "CONTRADICTS", "CONTEXT"]), claimIds: z.array(z.string().uuid()).max(100), facetKeys: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(12), entityIds: z.array(z.string().uuid()).max(100) }),
    "evidence.link": gatewayTool("evidence.link", "Associate existing evidence with an additional entity only. Create a separate evidence row when the same source supports another claim.", { evidenceId: z.string().uuid(), claimIds: z.array(z.string().uuid()).max(0), entityIds: z.array(z.string().uuid()).max(100) }),
    "case_note": gatewayTool("case_note", "Persist a concise operational rationale safe for the user-visible trace. Never include hidden reasoning.", { phase: z.string().min(1).max(100), status: z.string().min(1).max(100), publicRationale: z.string().min(10).max(500) }),
    "capabilities.list": gatewayTool("capabilities.list", "Read the immutable capability snapshot for this run.", {}),
  },
  "tool.execute.before": async (input, output) => {
    if (input.tool !== "task") return;
    const role = output.args?.subagent_type;
    if (!["professional-investigator", "github-investigator", "web-records-investigator", "social-investigator"].includes(role)) return;
    const prompt = typeof output.args?.prompt === "string" ? output.args.prompt : typeof output.args?.description === "string" ? output.args.description : "";
    const marker = prompt.match(/ASSIGNMENT_QUESTION_IDS\s*:\s*([^\n]+)/i)?.[1] ?? "";
    const questionIds = [...marker.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi)].map(([id]) => id);
    if (questionIds.length < 1 || questionIds.length > 3) throw new Error("Each specialist task must declare one to three question IDs in ASSIGNMENT_QUESTION_IDS.");
    const assignmentId = crypto.randomUUID();
    const assignmentText = `\n\nDurable assignment ${assignmentId}: work only on the question IDs in ASSIGNMENT_QUESTION_IDS.`;
    if (typeof output.args?.prompt === "string") output.args.prompt += assignmentText;
    else if (typeof output.args?.description === "string") output.args.description += assignmentText;
    taskAssignments.set(input.callID, assignmentId);
    await execute("research.authorize_task", { assignmentId, role, questionIds }, { sessionID: input.sessionID, agent: "lead-investigator", abort: AbortSignal.timeout(10_000) });
  },
  "tool.execute.after": async (input, output) => {
    if (input.tool !== "task") return;
    const role = input.args?.subagent_type;
    if (!["professional-investigator", "github-investigator", "web-records-investigator", "social-investigator"].includes(role)) return;
    const assignmentId = taskAssignments.get(input.callID);
    if (!assignmentId) return;
    const childSessionId = typeof output.metadata?.sessionId === "string" ? output.metadata.sessionId : undefined;
    if (childSessionId && needsChildHandoffContinuation(output.output)) {
      await execute("case_note", {
        phase: "subagent-handoff",
        status: "RETRYING",
        publicRationale: `${role} ended without a public handoff, so the same child session received its single bounded completion prompt.`,
      }, { sessionID: childSessionId, agent: role, abort: AbortSignal.timeout(10_000) }).catch(() => undefined);
      try {
        const continuation = await client.session.prompt({
          path: { id: childSessionId },
          query: { directory: "/workspace/case" },
          body: {
            agent: role,
            parts: [{ type: "text", text: "Your previous turn ended without a usable handoff. Do not perform broad new research and do not repeat a successful provider call. Persist or link any already-found evidence that directly bears on the assigned claims, resolve or exhaust every assigned question, then return a concise public handoff listing each question ID and terminal status. This is your only completion continuation; if blocked, record the limitation, exhaust the question, and stop." }],
          },
          signal: AbortSignal.timeout(5 * 60_000),
        });
        const text = continuation.data ? publicAssistantText(continuation.data.parts) : "";
        output.output = childTaskEnvelope(childSessionId, text || "The bounded child continuation produced no public text. Do not resume or re-delegate this role; inspect durable state, then resolve or exhaust its remaining questions.");
      } catch {
        output.output = childTaskEnvelope(childSessionId, "The bounded child continuation failed. Do not resume or re-delegate this role; preserve durable evidence and resolve or exhaust its remaining questions.");
      }
    }
    await execute("research.complete_task", { assignmentId, role }, { sessionID: input.sessionID, agent: "lead-investigator", abort: AbortSignal.timeout(10_000) });
    taskAssignments.delete(input.callID);
  },
  "experimental.session.compacting": async (_input, output) => {
    const response = await fetch(`${gatewayUrl}/internal/state/compaction`, {
      headers: { authorization: `Bearer ${token}`, "x-investigation-id": investigationId, "x-run-id": runId },
    });
    if (response.ok) output.context.push(await response.text());
  },
});

export default plugin;
