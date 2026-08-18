import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

const z = tool.schema;
const compactWordLimits = { summary: 220, conclusion: 90, evidenceComment: 35, rationale: 80, remainingGap: 40 } as const;
const wordCount = (value: string): number => {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
};
const compactText = (field: string, maximum: number) => z.string().superRefine((value, context) => {
  const actual = wordCount(value);
  if (actual > maximum) context.addIssue({ code: "custom", message: `${field} exceeds compact writing ceiling: ${actual} words; maximum ${maximum}.` });
});
const searchDomains = z.array(z.string().trim().min(1).max(500).regex(/^(?:\*\.)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/)).min(1).max(10)
  .transform((values) => [...new Set(values.map((value) => {
    const slash = value.indexOf("/");
    return slash < 0 ? value.toLocaleLowerCase("en-US") : `${value.slice(0, slash).toLocaleLowerCase("en-US")}${value.slice(slash)}`;
  }))].sort());
const utcTimestamp = z.iso.datetime({ offset: true })
  .refine((value) => value.endsWith("Z") && !Number.isNaN(Date.parse(value)), "Expected an ISO-8601 UTC timestamp.")
  .refine((value) => new Date(value).toISOString().slice(0, 10) === value.slice(0, 10), "Expected a valid UTC calendar date.")
  .transform((value) => new Date(value).toISOString());
const searchCategory = z.enum(["company", "people", "publication", "news", "personal site", "financial report"]);
const deepFocus = z.string().trim().min(2).max(600).refine((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value), "deepFocus must contain printable text.");
const sourceRef = z.string().regex(/^S[1-9]\d*$/);
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

function validatePairedSubpages(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const candidate = value as { url?: string; discoveryRef?: string; subpages?: number; subpageTarget?: string[] };
  if ((candidate.url === undefined) === (candidate.discoveryRef === undefined)) throw new Error("Exactly one of url or discoveryRef must be supplied.");
  if ((candidate.subpages === undefined) !== (candidate.subpageTarget === undefined)) throw new Error("subpages and subpageTarget must be supplied together.");
}

function validateSearchRoute(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const candidate = value as { mode?: string; category?: string; deepFocus?: string; additionalQueries?: string[]; query: string; includeDomains?: string[]; excludeDomains?: string[]; startPublishedDate?: string; endPublishedDate?: string; maxAgeHours?: number; livecrawlTimeout?: number };
  if (candidate.additionalQueries && !["deep", "deep-reasoning"].includes(candidate.mode ?? "auto")) throw new Error("additionalQueries require deep or deep-reasoning mode.");
  if (candidate.deepFocus && !["deep", "deep-reasoning"].includes(candidate.mode ?? "auto")) throw new Error("deepFocus requires deep or deep-reasoning mode.");
  if (candidate.additionalQueries?.some((query) => query.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US") === candidate.query.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US"))) throw new Error("additionalQueries cannot duplicate the primary query.");
  if (candidate.category === "people" && (candidate.includeDomains || candidate.excludeDomains || candidate.startPublishedDate || candidate.endPublishedDate)) throw new Error("People search does not accept domain or date filters.");
  if (candidate.category === "company" && (candidate.includeDomains || candidate.excludeDomains || candidate.startPublishedDate || candidate.endPublishedDate)) throw new Error("Company search does not accept domain or date filters.");
  if (candidate.livecrawlTimeout !== undefined && (candidate.maxAgeHours === undefined || candidate.maxAgeHours < 0)) throw new Error("livecrawlTimeout requires a non-negative maxAgeHours.");
}

function validateBatchSearch(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const searches = (value as { searches?: Array<{ query: string }> }).searches ?? [];
  const normalized = searches.map(({ query }) => query.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US"));
  if (new Set(normalized).size !== normalized.length) throw new Error("Batch search queries must be distinct.");
  for (const search of searches) validateSearchRoute({ ...search, mode: "auto" });
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

const pdfTargetAnchor = z.object({
  kind: z.literal("PDF_TEXT"),
  page: z.number().int().positive(),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  exact: z.string().trim().min(1).max(6_000),
}).strict();
const target = z.object({
  id: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  section: z.string().trim().min(1).max(200),
  predicate: z.string().trim().min(1).max(6_000),
  importance: z.enum(["HIGH", "MEDIUM"]),
  anchor: z.discriminatedUnion("kind", [pdfTargetAnchor, z.object({ kind: z.literal("DISCOVERED"), basis: z.string().trim().min(1).max(2_000) }).strict()]),
}).strict();
const findingEvidence = z.object({
  sourceRef: z.string().regex(/^S[1-9]\d*$/),
  relation: z.enum(["SUPPORTS", "CONTRADICTS", "CONTEXT"]),
  comment: compactText("evidence comment", compactWordLimits.evidenceComment).trim().min(1).max(6_000),
}).strict();
const finding = {
  targetId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  conclusion: compactText("conclusion", compactWordLimits.conclusion).trim().min(1).max(6_000),
  status: z.enum(["ESTABLISHED", "PARTIAL", "UNRESOLVED", "CONFLICTING", "CONTRADICTED"]),
  evidence: z.array(findingEvidence).max(200),
  rationale: compactText("rationale", compactWordLimits.rationale).trim().min(1).max(12_000),
  remainingGap: compactText("remainingGap", compactWordLimits.remainingGap).trim().max(2_000).nullable(),
};

const plugin: Plugin = async () => {
  const assignments = new Map<string, string>();
  const sessionSourceRefs = new Map<string, Set<string>>();
  const routeHistory = new Map<string, string[]>();

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
    if (name !== "source.excerpts" && name !== "source.inventory" && name !== "research.state.set" && name !== "research.state.get" && !name.startsWith("investigation.") && !name.startsWith("report.")) {
      const routes = routeHistory.get(context.sessionID) ?? [];
      routes.push(`${name} ${safeJson(args, 400)}`);
      routeHistory.set(context.sessionID, routes.slice(-100));
    }
    return body;
  }

  function gatewayTool(name: string, description: string, args: Parameters<typeof tool>[0]["args"], validate?: (values: unknown) => void) {
    return tool({ description, args, async execute(values, context) { validate?.(values); return execute(name, values, context); } });
  }

  const tools = {
    "web.search": gatewayTool("web.search", "Search broadly with Exa. Use ten highlighted leads by default; search is discovery only, so fetch a promising URL or discoveryRef before citing it. Use deep routes only for a material unresolved gap.", { query: z.string().trim().min(2).max(1000), mode: z.enum(["fast", "auto", "deep-lite", "deep", "deep-reasoning"]).default("auto"), highlightQuery: z.string().trim().min(2).max(1000).optional(), resultLimit: z.number().int().min(1).max(10).default(10), category: searchCategory.optional(), deepFocus: deepFocus.optional(), includeDomains: searchDomains.optional(), additionalQueries: z.array(z.string().trim().min(2).max(1000)).min(1).max(6).optional(), excludeDomains: searchDomains.optional(), startPublishedDate: utcTimestamp.optional(), endPublishedDate: utcTimestamp.optional(), maxAgeHours: z.number().int().min(-1).max(8760).optional(), livecrawlTimeout: z.number().int().min(1000).max(15000).optional() }, validateSearchRoute),
    "web.search.batch": gatewayTool("web.search.batch", "Run two to six independent ordinary Exa searches concurrently. Each item returns ten highlighted discovery leads; use this for the initial portfolio, not deep escalation.", { searches: z.array(z.object({ query: z.string().trim().min(2).max(1000), highlightQuery: z.string().trim().min(2).max(1000).optional(), category: searchCategory.optional(), includeDomains: searchDomains.optional(), excludeDomains: searchDomains.optional(), startPublishedDate: utcTimestamp.optional(), endPublishedDate: utcTimestamp.optional(), maxAgeHours: z.number().int().min(-1).max(8760).optional(), livecrawlTimeout: z.number().int().min(1000).max(15000).optional() }).strict()).min(2).max(6) }, validateBatchSearch),
    "web.fetch": gatewayTool("web.fetch", "Capture direct evidence from a known authoritative URL or a SEARCH_DISCOVERY discoveryRef. Request bounded target subpages from an authoritative hub with paired controls; this is not discovery.", { url: z.string().url().optional(), discoveryRef: sourceRef.optional(), focus: z.string().min(2).max(1000).optional(), subpages: z.number().int().min(1).max(10).optional(), subpageTarget: z.array(z.string().trim().min(2).max(1000)).min(1).max(10).optional() }, validatePairedSubpages),
    "professional.profile": gatewayTool("professional.profile", "Retrieve one professional profile for a material identity or chronology question.", { username: z.string().min(2).max(200), requiredMaterialField: z.enum(["IDENTITY", "CURRENT_POSITION", "EMPLOYMENT_HISTORY", "EDUCATION"]).default("IDENTITY") }),
    "professional.activity": gatewayTool("professional.activity", "Retrieve professional activity only for a material chronology or ownership gap.", { username: z.string().min(2).max(200) }),
    "social.profile": gatewayTool("social.profile", "Retrieve a public social profile only for an explicitly allowed material reason.", { platform: z.enum(["X", "INSTAGRAM", "TIKTOK"]), handle: z.string().min(1).max(200), reason: z.enum(["EXPLICIT_SOCIAL_CLAIM", "PUBLIC_IDENTITY_CROSS_LINK", "MATERIAL_ACTIVITY_QUESTION"]) }),
    "github.graphql": gatewayTool("github.graphql", "Query public GitHub contribution records.", { query: z.string().min(1).max(20000), variables: z.record(z.string(), z.any()).default({}) }),
    "github.rest": gatewayTool("github.rest", "Read an allowlisted public GitHub REST resource.", { path: z.string().min(2).max(1000) }),
    "github.clone": gatewayTool("github.clone", "Inspect bounded public repository history only when API records are insufficient.", { repository: z.string().min(3).max(201), ref: z.string().max(200).optional(), authorHint: z.string().max(200).optional() }),
    "archives.search": gatewayTool("archives.search", "Use only for a known historical URL or domain and return dated archive captures; an archive snapshot supports the captured page, not every claim about it.", { url: z.string().url(), fromYear: z.number().int().min(1996).max(2100).optional(), toYear: z.number().int().min(1996).max(2100).optional() }),
    "public_records.search": gatewayTool("public_records.search", "Search one relevant public record route.", { recordType: z.enum(["PATENT", "SEC", "IETF"]), query: z.string().min(2).max(1000) }),
    "scholarly.search": gatewayTool("scholarly.search", "Search one relevant scholarly route.", { query: z.string().min(2).max(1000) }),
    "packages.inspect": gatewayTool("packages.inspect", "Inspect one named package's public registry metadata for package identity, releases, authorship, or maintenance context; do not infer impact from package existence alone.", { registry: z.enum(["NPM", "PYPI", "HUGGING_FACE"]), package: z.string().min(1).max(300) }),
    "security_records.search": gatewayTool("security_records.search", "Search one relevant public vulnerability route.", { ecosystem: z.string().max(100).optional(), package: z.string().max(300).optional(), cve: z.string().max(40).optional() }),
    "source.inventory": gatewayTool("source.inventory", "List every captured source reference, including discovery leads. Discovery records are not citable.", { cursor: z.string().regex(/^S[1-9]\d*$/).optional(), limit: z.number().int().min(1).max(100).default(100) }),
    "source.excerpts": gatewayTool("source.excerpts", "Reuse one immutable local source before making a provider call. Ask for several short anchors when a claim has multiple facets; returned wording and S references come from stored content.", { sourceRef: z.string().regex(/^S[1-9]\d*$/), queries: z.array(z.string().min(1).max(500)).min(1).max(12), maxCharacters: z.number().int().min(1).max(60000).optional() }),
    "research.state.set": gatewayTool("research.state.set", "Persist the final machine-readable claim ledger. Set publicationReady true only after the final gap pass is genuinely complete.", { publicationReady: z.boolean(), claims: z.array(z.object(claim).strict()).min(1).max(500), identityAnchors: z.array(z.string().min(1).max(500)).max(100).default([]) }),
    "research.state.get": gatewayTool("research.state.get", "Recover the frozen durable claim ledger in deterministic pages of at most 25 claims. This is read-only.", { cursor: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/).optional(), limit: z.number().int().min(1).max(25).default(25) }),
    "investigation.plan.set": gatewayTool("investigation.plan.set", "Establish the durable material-target queue. PDF_TEXT targets must use exact résumé page/line anchors; DISCOVERED targets require a materiality basis.", { identityAnchors: z.array(z.string().trim().min(1).max(500)).max(100).default([]), targets: z.array(target).min(1).max(500) }),
    "investigation.target.add": gatewayTool("investigation.target.add", "Add one material target discovered during research without rewriting existing targets.", { target }),
    "investigation.synthesis.begin": gatewayTool("investigation.synthesis.begin", "Transition the durable investigation from research into one-finding-at-a-time synthesis.", {}),
    "investigation.finding.upsert": gatewayTool("investigation.finding.upsert", "Persist one assertion-level finding. Every evidence comment must state what its source establishes and, where relevant, the material boundary it does not establish.", finding),
    "investigation.progress.get": gatewayTool("investigation.progress.get", "Recover the durable v3 phase, targets, findings, summary, and host source inventory after compaction.", {}),
    "investigation.summary.set": gatewayTool("investigation.summary.set", "Persist the final summary and list target IDs considered; every HIGH target must be included before commit.", { text: compactText("summary text", compactWordLimits.summary).trim().min(1).max(50_000), targetIds: z.array(z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)).max(500) }),
    "investigation.commit": gatewayTool("investigation.commit", "Prevalidate, drain in-flight provider work, refresh host inventory, revalidate, and atomically commit the v3 investigation.", {}),
    "report.summary.set": gatewayTool("report.summary.set", "Set the final investigation summary and link it to frozen research claims.", { summary: z.string().min(1).max(50000), researchClaimIds: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)).min(1).max(500) }),
    "report.finding.upsert": gatewayTool("report.finding.upsert", "Register or repair one résumé finding with exact PDF anchors, linked frozen claims, and captured eligible sources.", { findingId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/), section: z.string().min(1).max(200), claim: z.string().min(1).max(6000), anchor: z.object({ kind: z.literal("PDF_TEXT"), page: z.number().int().positive(), lineStart: z.number().int().positive(), lineEnd: z.number().int().positive(), exact: z.string().min(1).max(6000) }).strict(), evidence: z.string().min(1).max(12000), notes: z.string().max(6000).optional(), status: z.union([z.literal(-2), z.literal(-1), z.literal(0), z.literal(1), z.literal(2)]), sourceRefs: z.array(z.string().regex(/^S[1-9]\d*$/)).max(200), researchClaimIds: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)).min(1).max(500) }),
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
      const references = `Complete captured S references (contiguous ranges are exact): ${compactRefs(refs)}`;
      const context = `${references}\nHeadless durable investigation state:\n- Assignment: ${assignments.get(input.sessionID) ?? "Continue the current input scope."}\n- Hard deadline: ${deadlineAt ?? "host controlled"}\n- Attempted routes: ${safeJson(routes, 2_000)}\n- Recover v3 state with investigation.progress.get; do not inject or reconstruct serialized targets or findings.\n- Use source.inventory/source.excerpts for local recovery; never repeat a provider call merely to recover captured content.\n- During SYNTHESIZING, research may continue when a resolvable material gap remains. Write one finding at a time and preserve the final evidence comments verbatim.\n- Consequential claims: accept a dispositive authoritative primary record, authoritative evidence plus independent corroboration, or exhausted materially different public routes. Subject-controlled material is a lead and cannot alone establish a consequential claim unless it is itself the authoritative system of record. Discovery records are leads, not report citations.`;
      const remainingBytes = Math.max(0, 8 * 1024 - Buffer.byteLength(`${references}\n`, "utf8"));
      output.context.push(`${references}\n${truncateUtf8(context.slice(references.length + 1), remainingBytes)}`);
    },
  };
};

export default plugin;
