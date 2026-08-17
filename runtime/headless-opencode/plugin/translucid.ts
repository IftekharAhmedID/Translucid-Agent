import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

const z = tool.schema;
const includeDomains = z.array(z.string().trim().min(1).max(500).regex(/^(?:\*\.)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/)).min(1).max(10)
  .transform((values) => [...new Set(values.map((value) => {
    const slash = value.indexOf("/");
    return slash < 0 ? value.toLocaleLowerCase("en-US") : `${value.slice(0, slash).toLocaleLowerCase("en-US")}${value.slice(slash)}`;
  }))].sort());
const gatewayUrl = process.env.CASE_GATEWAY_URL;
const token = process.env.CASE_TOKEN;
const runId = process.env.RUN_ID;
const deadlineAt = process.env.CASE_DEADLINE_AT;

if (!gatewayUrl || !token || !runId) throw new Error("Headless run gateway environment is incomplete.");
const configuredGatewayUrl = gatewayUrl;
const configuredToken = token;
const configuredRunId = runId;

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

function returnedSourceRefs(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const refs = [parsed.sourceRefs, parsed.evidenceEligibleSourceRefs]
      .flatMap((value) => Array.isArray(value) ? value : [])
      .concat(typeof parsed.sourceRef === "string" ? [parsed.sourceRef] : [])
      .concat(Array.isArray(parsed.sources) ? parsed.sources.flatMap((value) => value && typeof value === "object" && typeof (value as { ref?: unknown }).ref === "string" ? [(value as { ref: string }).ref] : []) : [])
      .filter((value): value is string => typeof value === "string" && /^S[1-9]\d*$/.test(value));
    return [...new Set(refs)].sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
  } catch {
    return [];
  }
}

function safeJson(value: unknown, maximumBytes: number): string {
  try { return truncateUtf8(JSON.stringify(value), maximumBytes); }
  catch { return "unavailable"; }
}

function compactRefs(refs: string[]): string {
  if (!refs.length) return "none";
  const numbers = refs.map((ref) => Number(ref.slice(1))).sort((left, right) => left - right);
  const ranges: string[] = [];
  let start = numbers[0]!;
  let end = start;
  for (const value of numbers.slice(1)) {
    if (value === end + 1) {
      end = value;
      continue;
    }
    ranges.push(start === end ? `S${start}` : `S${start}-S${end}`);
    start = end = value;
  }
  ranges.push(start === end ? `S${start}` : `S${start}-S${end}`);
  return ranges.join(", ");
}

const claim = {
  id: z.string().trim().min(1).max(100),
  claim: z.string().trim().min(1).max(6_000),
  provisionalStatus: z.enum(["established", "provisional", "conflicting", "unresolved"]),
  supportingRefs: z.array(z.string().regex(/^S[1-9]\d*$/)).max(200),
  conflictingRefs: z.array(z.string().regex(/^S[1-9]\d*$/)).max(200),
  remainingGap: z.string().trim().max(2_000).nullable(),
  importance: z.string().trim().min(1).max(100),
};

const plugin: Plugin = async () => {
  const assignments = new Map<string, string>();
  const sessionSourceRefs = new Map<string, Set<string>>();
  const routeHistory = new Map<string, string[]>();
  const claimStates = new Map<string, string>();

  async function execute(name: string, args: unknown, context: { sessionID: string; agent: string; callID?: string; abort: AbortSignal }) {
    const response = await fetch(`${configuredGatewayUrl}/internal/tools/execute`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${configuredToken}`,
        "content-type": "application/json",
        "x-run-id": configuredRunId,
        "x-opencode-agent": context.agent,
      },
      body: JSON.stringify({ tool: name, arguments: args, operational: { sessionId: context.sessionID, agent: context.agent, callId: context.callID } }),
      signal: context.abort,
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Gateway rejected ${name} (${response.status}): ${body.slice(0, 300)}`);
    const refs = sessionSourceRefs.get(context.sessionID) ?? new Set<string>();
    for (const ref of returnedSourceRefs(body)) refs.add(ref);
    sessionSourceRefs.set(context.sessionID, refs);
    if (name !== "source.excerpts" && name !== "source.inventory" && name !== "research.state.set" && !name.startsWith("report.")) {
      const routes = routeHistory.get(context.sessionID) ?? [];
      routes.push(`${name} ${safeJson(args, 400)}`);
      routeHistory.set(context.sessionID, routes.slice(-100));
    }
    if (name === "research.state.set") claimStates.set(context.sessionID, safeJson(args, 4_000));
    return body;
  }

  function gatewayTool(name: string, description: string, args: Parameters<typeof tool>[0]["args"]) {
    return tool({ description, args, async execute(values, context) { return execute(name, values, context); } });
  }

  const tools = {
    "web.search": gatewayTool("web.search", "Search public sources. Every captured result has an immutable S reference; search results are leads and not report citations.", { query: z.string().min(2).max(1000), mode: z.enum(["fast", "auto", "deep", "deep-reasoning"]).default("auto"), highlightQuery: z.string().min(2).max(1000).optional(), resultLimit: z.number().int().min(1).max(10).default(10), includeDomains: includeDomains.optional() }),
    "web.fetch": gatewayTool("web.fetch", "Capture one direct investigation lead as an immutable source. Add focus when a claim or gap should guide the returned preview.", { url: z.string().url(), focus: z.string().min(2).max(1000).optional() }),
    "professional.profile": gatewayTool("professional.profile", "Retrieve one professional profile for a material identity or chronology question.", { username: z.string().min(2).max(200), requiredMaterialField: z.enum(["IDENTITY", "CURRENT_POSITION", "EMPLOYMENT_HISTORY", "EDUCATION"]).default("IDENTITY") }),
    "professional.activity": gatewayTool("professional.activity", "Retrieve professional activity only for a material chronology or ownership gap.", { username: z.string().min(2).max(200) }),
    "social.profile": gatewayTool("social.profile", "Retrieve a public social profile only for an explicitly allowed material reason.", { platform: z.enum(["X", "INSTAGRAM", "TIKTOK"]), handle: z.string().min(1).max(200), reason: z.enum(["EXPLICIT_SOCIAL_CLAIM", "PUBLIC_IDENTITY_CROSS_LINK", "MATERIAL_ACTIVITY_QUESTION"]) }),
    "github.graphql": gatewayTool("github.graphql", "Query public GitHub contribution records.", { query: z.string().min(1).max(20000), variables: z.record(z.string(), z.any()).default({}) }),
    "github.rest": gatewayTool("github.rest", "Read an allowlisted public GitHub REST resource.", { path: z.string().min(2).max(1000) }),
    "github.clone": gatewayTool("github.clone", "Inspect bounded public repository history only when API records are insufficient.", { repository: z.string().min(3).max(201), ref: z.string().max(200).optional(), authorHint: z.string().max(200).optional() }),
    "archives.search": gatewayTool("archives.search", "Find dated public archive captures.", { url: z.string().url(), fromYear: z.number().int().min(1996).max(2100).optional(), toYear: z.number().int().min(1996).max(2100).optional() }),
    "public_records.search": gatewayTool("public_records.search", "Search one relevant public record route.", { recordType: z.enum(["PATENT", "SEC", "IETF"]), query: z.string().min(2).max(1000) }),
    "scholarly.search": gatewayTool("scholarly.search", "Search one relevant scholarly route.", { query: z.string().min(2).max(1000) }),
    "packages.inspect": gatewayTool("packages.inspect", "Inspect public package metadata.", { registry: z.enum(["NPM", "PYPI", "HUGGING_FACE"]), package: z.string().min(1).max(300) }),
    "security_records.search": gatewayTool("security_records.search", "Search one relevant public vulnerability route.", { ecosystem: z.string().max(100).optional(), package: z.string().max(300).optional(), cve: z.string().max(40).optional() }),
    "source.inventory": gatewayTool("source.inventory", "List every captured source reference, including discovery leads. Discovery records are not citable.", { cursor: z.string().regex(/^S[1-9]\d*$/).optional(), limit: z.number().int().min(1).max(100).default(100) }),
    "source.excerpts": gatewayTool("source.excerpts", "Search one immutable local source for exact detail without a network call.", { sourceRef: z.string().regex(/^S[1-9]\d*$/), queries: z.array(z.string().min(1).max(500)).min(1).max(12), maxCharacters: z.number().int().min(1).max(60000).optional() }),
    "research.state.set": gatewayTool("research.state.set", "Persist the investigation's current machine-readable claim state before publication.", { claims: z.array(z.object(claim).strict()).min(1).max(500), identityAnchors: z.array(z.string().min(1).max(500)).max(100).default([]) }),
    "report.summary.set": gatewayTool("report.summary.set", "Set the final investigation summary.", { summary: z.string().min(1).max(50000) }),
    "report.finding.upsert": gatewayTool("report.finding.upsert", "Register or repair one résumé finding with exact PDF anchors and captured eligible sources.", { findingId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/), section: z.string().min(1).max(200), claim: z.string().min(1).max(6000), anchor: z.object({ kind: z.literal("PDF_TEXT"), page: z.number().int().positive(), lineStart: z.number().int().positive(), lineEnd: z.number().int().positive(), exact: z.string().min(1).max(6000) }).strict(), evidence: z.string().min(1).max(12000), notes: z.string().max(6000).optional(), status: z.union([z.literal(-2), z.literal(-1), z.literal(0), z.literal(1), z.literal(2)]), sourceRefs: z.array(z.string().regex(/^S[1-9]\d*$/)).max(200) }),
    "report.finding.remove": gatewayTool("report.finding.remove", "Remove one obsolete finding during final coverage repair.", { findingId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/) }),
    "report.progress.get": gatewayTool("report.progress.get", "Read the durable report draft and coverage state.", {}),
    "report.finalize": gatewayTool("report.finalize", "Lock the report after the final coverage and source review.", {}),
  };

  return {
    "chat.headers": async (input, output) => {
      output.headers["x-run-id"] = configuredRunId;
      output.headers["x-opencode-agent"] = input.agent;
    },
    "chat.message": async (input, output) => {
      if (assignments.has(input.sessionID)) return;
      const text = output.parts.flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n").trim();
      if (text) assignments.set(input.sessionID, truncateUtf8(text, 2 * 1024));
    },
    tool: tools,
    "experimental.session.compacting": async (input, output) => {
      const refs = [...(sessionSourceRefs.get(input.sessionID) ?? [])].sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
      const routes = routeHistory.get(input.sessionID) ?? [];
      const state = claimStates.get(input.sessionID) ?? "none saved yet; save research.state.set before publication";
      const references = `Complete captured S references (contiguous ranges are exact): ${compactRefs(refs)}`;
      const context = `${references}\nHeadless durable investigation state:\n- Assignment: ${assignments.get(input.sessionID) ?? "Continue the current input scope."}\n- Hard deadline: ${deadlineAt ?? "host controlled"}\n- Attempted routes: ${safeJson(routes, 2_000)}\n- Latest claim state: ${state}\n- Use source.inventory/source.excerpts for local recovery; never repeat a provider call merely to recover captured content.\n- Consequential claims: accept a dispositive authoritative primary record, authoritative evidence plus independent corroboration, or exhausted materially different public routes. Subject-controlled material is a lead and cannot alone establish a consequential claim unless it is itself the authoritative system of record. Discovery records are leads, not report citations.`;
      const remainingBytes = Math.max(0, 8 * 1024 - Buffer.byteLength(`${references}\n`, "utf8"));
      output.context.push(`${references}\n${truncateUtf8(context.slice(references.length + 1), remainingBytes)}`);
    },
  };
};

export default plugin;
