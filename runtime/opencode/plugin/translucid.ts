import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

const z = tool.schema;
const gatewayUrl = process.env.CASE_GATEWAY_URL;
const token = process.env.CASE_TOKEN;
const investigationId = process.env.INVESTIGATION_ID;
const runId = process.env.RUN_ID;

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

const plugin: Plugin = async () => ({
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
    "claim.create": gatewayTool("claim.create", "Persist one normalized candidate claim.", { category: z.string().min(1).max(100), normalizedClaim: z.string().min(1).max(4000), materiality: z.enum(["HIGH", "MEDIUM", "LOW"]), sourceSpan: z.record(z.string(), z.any()).optional() }),
    "entity.upsert": gatewayTool("entity.upsert", "Create or update a distinct entity. Only the lead may assign CANDIDATE_ROOT; every external account or record starts as EXTERNAL.", { type: z.enum(["PERSON", "ORGANIZATION", "ACCOUNT", "WEBSITE", "PUBLICATION", "PATENT", "PACKAGE"]), canonicalName: z.string().min(1).max(500), role: z.enum(["CANDIDATE_ROOT", "EXTERNAL"]), metadata: z.record(z.string(), z.any()).optional() }),
    "entity.add_identifier": gatewayTool("entity.add_identifier", "Add an evidence-backed normalized identifier.", { entityId: z.string().uuid(), type: z.string().min(1).max(100), value: z.string().min(1).max(1000), confidence: z.number().min(0).max(1), evidenceId: z.string().uuid() }),
    "entity.link": gatewayTool("entity.link", "Link entities only with two distinct anchor types whose evidence belongs to backend-verified independent source families.", { fromEntityId: z.string().uuid(), toEntityId: z.string().uuid(), relationship: z.string().min(1).max(100), anchors: z.array(z.object({ type: z.enum(["EMPLOYER_OVERLAP", "VERIFIED_DOMAIN", "CROSS_LINKED_ACCOUNT", "LOCATION_HISTORY", "REPOSITORY_IDENTITY", "AUTHORED_PAGE"]), evidenceId: z.string().uuid() })).min(2).max(20) }),
    "entity.get_graph": gatewayTool("entity.get_graph", "Read the durable entity graph.", {}),
    "observation.record": gatewayTool("observation.record", "Record a temporal observation from a captured artifact.", { artifactId: z.string().uuid(), entityId: z.string().uuid(), field: z.string().min(1).max(200), valueJson: z.any(), sourceEventAt: z.string().datetime().optional(), validFrom: z.string().datetime().optional(), validTo: z.string().datetime().optional() }),
    "observation.list_timeline": gatewayTool("observation.list_timeline", "Read the data-backed timeline without collapsing conflicts.", { entityId: z.string().uuid().optional() }),
    "research.open": gatewayTool("research.open", "Open a durable research question before using an expensive tool. possibleRoutes must be exact semantic tool IDs.", { claimIds: z.array(z.string().uuid()).max(100), question: z.string().min(5).max(2000), priority: z.enum(["HIGH", "MEDIUM", "LOW"]), possibleRoutes: z.array(researchRoute).min(1).max(20) }),
    "research.select_route": gatewayTool("research.select_route", "Select a route using exactly one semantic tool ID already stored in possibleRoutes.", { questionId: z.string().uuid(), route: researchRoute, publicRationale: z.string().min(10).max(500) }),
    "research.update": gatewayTool("research.update", "Update an open durable question. possibleRoutes must be exact semantic tool IDs.", { questionId: z.string().uuid(), priority: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(), possibleRoutes: z.array(researchRoute).min(1).max(20).optional(), status: z.enum(["OPEN", "IN_PROGRESS"]).optional(), publicRationale: z.string().min(10).max(500) }),
    "research.resolve": gatewayTool("research.resolve", "Resolve, exhaust, or skip a durable research question.", { questionId: z.string().uuid(), status: z.enum(["RESOLVED", "EXHAUSTED", "SKIPPED"]), resolutionSummary: z.string().min(5).max(2000) }),
    "research.list": gatewayTool("research.list", "Read the current durable research frontier.", {}),
    "research.begin_wave": gatewayTool("research.begin_wave", "Begin the initial research wave or one evidence-justified targeted second wave before native task delegation.", { waveKind: z.enum(["INITIAL", "TARGETED"]), questionIds: z.array(z.string().uuid()).min(1).max(12), escalationReason: z.enum(["MATERIAL_CONTRADICTION", "IDENTITY_AMBIGUITY", "CHRONOLOGY_CONFLICT", "NEW_EVIDENCE_FAMILY", "MATERIAL_UNCERTAINTY"]).optional(), publicRationale: z.string().min(10).max(500) }),
    "evidence.capture": gatewayTool("evidence.capture", "Create evidence from an exact quote in an immutable non-snippet artifact. Source authority is assigned by the gateway.", { artifactId: z.string().uuid(), exactQuote: z.string().min(1).max(12000), sourceLocation: z.record(z.string(), z.any()).optional(), relation: z.enum(["SUPPORTS", "CONTRADICTS", "CONTEXT"]), claimIds: z.array(z.string().uuid()).max(100), entityIds: z.array(z.string().uuid()).max(100) }),
    "evidence.link": gatewayTool("evidence.link", "Link existing evidence to additional durable claims or entities in this run.", { evidenceId: z.string().uuid(), claimIds: z.array(z.string().uuid()).max(100), entityIds: z.array(z.string().uuid()).max(100) }),
    "case_note": gatewayTool("case_note", "Persist a concise operational rationale safe for the user-visible trace. Never include hidden reasoning.", { phase: z.string().min(1).max(100), status: z.string().min(1).max(100), publicRationale: z.string().min(10).max(500) }),
    "capabilities.list": gatewayTool("capabilities.list", "Read the immutable capability snapshot for this run.", {}),
  },
  "tool.execute.before": async (input, output) => {
    if (input.tool !== "task") return;
    const role = output.args?.subagent_type;
    if (!["professional-investigator", "github-investigator", "web-records-investigator", "social-investigator"].includes(role)) return;
    await execute("research.authorize_task", { role }, { sessionID: input.sessionID, agent: "lead-investigator", abort: AbortSignal.timeout(10_000) });
  },
  "tool.execute.after": async (input) => {
    if (input.tool !== "task") return;
    const role = input.args?.subagent_type;
    if (!["professional-investigator", "github-investigator", "web-records-investigator", "social-investigator"].includes(role)) return;
    await execute("research.complete_task", { role }, { sessionID: input.sessionID, agent: "lead-investigator", abort: AbortSignal.timeout(10_000) });
  },
  "experimental.session.compacting": async (_input, output) => {
    const response = await fetch(`${gatewayUrl}/internal/state/compaction`, {
      headers: { authorization: `Bearer ${token}`, "x-investigation-id": investigationId, "x-run-id": runId },
    });
    if (response.ok) output.context.push(await response.text());
  },
});

export default plugin;
