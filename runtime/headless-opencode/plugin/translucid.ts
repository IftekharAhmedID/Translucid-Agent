import { mkdir, writeFile } from "node:fs/promises";

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

const z = tool.schema;
const gatewayUrl = process.env.CASE_GATEWAY_URL;
const token = process.env.CASE_TOKEN;
const runId = process.env.RUN_ID;
const deadlineAt = process.env.CASE_DEADLINE_AT;

if (!gatewayUrl || !token || !runId) throw new Error("Headless run gateway environment is incomplete.");

const specialistRoles = ["professional-researcher", "github-researcher", "web-records-researcher", "social-researcher"] as const;
const roleCounts = new Map<string, number>();
const taskWave = new Map<string, "INITIAL" | "TARGETED">();
let totalChildren = 0;
let targetedStarted = false;

async function execute(name: string, args: unknown, context: { sessionID: string; agent: string; abort: AbortSignal }) {
  const response = await fetch(`${gatewayUrl}/internal/tools/execute`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-run-id": runId,
      "x-opencode-agent": context.agent,
    },
    body: JSON.stringify({ tool: name, arguments: args, operational: { sessionId: context.sessionID, agent: context.agent } }),
    signal: context.abort,
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Gateway rejected ${name} (${response.status}): ${body.slice(0, 300)}`);
  return body;
}

function gatewayTool(
  name: string,
  description: string,
  args: Record<string, ReturnType<typeof z.string> | ReturnType<typeof z.array> | ReturnType<typeof z.enum> | ReturnType<typeof z.record> | ReturnType<typeof z.number> | ReturnType<typeof z.any>>,
) {
  return tool({ description, args, async execute(values, context) { return execute(name, values, context); } });
}

const tools = {
  "web.search": gatewayTool("web.search", "Discover public sources with targeted highlights. Returned S references identify immutable captures.", { query: z.string().min(2).max(1000), mode: z.enum(["fast", "auto"]).default("fast"), highlightQuery: z.string().min(2).max(1000).optional(), resultLimit: z.number().int().min(1).max(10).default(5) }),
  "web.fetch": gatewayTool("web.fetch", "Capture one public page as an immutable source.", { url: z.string().url() }),
  "professional.profile": gatewayTool("professional.profile", "Retrieve one full professional profile with one conditional fallback for a missing material field.", { username: z.string().min(2).max(200), requiredMaterialField: z.enum(["IDENTITY", "CURRENT_POSITION", "EMPLOYMENT_HISTORY", "EDUCATION"]).default("IDENTITY") }),
  "professional.activity": gatewayTool("professional.activity", "Escalation-only retrieval for material activity, chronology, ownership, or leadership gaps.", { username: z.string().min(2).max(200) }),
  "social.profile": gatewayTool("social.profile", "Retrieve one public social profile for an explicitly allowed material reason.", { platform: z.enum(["X", "INSTAGRAM", "TIKTOK"]), handle: z.string().min(1).max(200), reason: z.enum(["EXPLICIT_SOCIAL_CLAIM", "PUBLIC_IDENTITY_CROSS_LINK", "MATERIAL_ACTIVITY_QUESTION"]) }),
  "github.graphql": gatewayTool("github.graphql", "Query public GitHub contribution records.", { query: z.string().min(1).max(20000), variables: z.record(z.string(), z.any()).default({}) }),
  "github.rest": gatewayTool("github.rest", "Read an allowlisted public GitHub REST resource.", { path: z.string().min(2).max(1000) }),
  "github.clone": gatewayTool("github.clone", "Inspect bounded public repository history and patches only when API records are insufficient.", { repository: z.string().min(3).max(201), ref: z.string().max(200).optional(), authorHint: z.string().max(200).optional() }),
  "archives.search": gatewayTool("archives.search", "Find dated Wayback or Common Crawl captures.", { url: z.string().url(), fromYear: z.number().int().min(1996).max(2100).optional(), toYear: z.number().int().min(1996).max(2100).optional() }),
  "public_records.search": gatewayTool("public_records.search", "Search a patent, SEC, or IETF public record.", { recordType: z.enum(["PATENT", "SEC", "IETF"]), query: z.string().min(2).max(1000) }),
  "scholarly.search": gatewayTool("scholarly.search", "Find scholarly works through configured public indexes.", { query: z.string().min(2).max(1000) }),
  "packages.inspect": gatewayTool("packages.inspect", "Inspect public package metadata and repository links.", { registry: z.enum(["NPM", "PYPI", "HUGGING_FACE"]), package: z.string().min(1).max(300) }),
  "security_records.search": gatewayTool("security_records.search", "Search public vulnerability records.", { ecosystem: z.string().max(100).optional(), package: z.string().max(300).optional(), cve: z.string().max(40).optional() }),
  "source.excerpts": gatewayTool("source.excerpts", "Search one immutable S reference locally for exact JSON scalar paths or bounded text windows without a network call.", { sourceRef: z.string().regex(/^S[1-9]\d*$/), queries: z.array(z.string().min(1).max(500)).min(1).max(12), maxCharacters: z.number().int().min(1).max(300000).optional() }),
};

function taskPrompt(args: Record<string, unknown>): string {
  return typeof args.prompt === "string" ? args.prompt : typeof args.description === "string" ? args.description : "";
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
}

const plugin: Plugin = async () => ({
  "chat.headers": async (input, output) => {
    output.headers["x-run-id"] = runId;
    output.headers["x-opencode-agent"] = input.agent;
  },
  tool: tools,
  "tool.execute.before": async (input, output) => {
    if (input.tool !== "task") return;
    const role = output.args?.subagent_type;
    if (!specialistRoles.includes(role)) return;
    const prompt = taskPrompt(output.args ?? {});
    const wave = prompt.match(/\bWAVE:\s*(INITIAL|TARGETED)\b/i)?.[1]?.toLocaleUpperCase("en-US") as "INITIAL" | "TARGETED" | undefined;
    if (!wave) throw new Error("Every specialist task must declare WAVE: INITIAL or WAVE: TARGETED.");
    if (wave === "INITIAL" && targetedStarted) throw new Error("An initial task cannot start after the targeted wave.");
    if (wave === "TARGETED") targetedStarted = true;
    if ((roleCounts.get(role) ?? 0) >= 2) throw new Error(`${role} has already reached its two-invocation limit.`);
    if (totalChildren >= 8) throw new Error("The run has reached its eight-child research limit.");
    if (role === "social-researcher" && !/SOCIAL_REASON:\s*(EXPLICIT_SOCIAL_CLAIM|PUBLIC_IDENTITY_CROSS_LINK|MATERIAL_ACTIVITY_QUESTION)/.test(prompt)) {
      throw new Error("Social research requires one explicit allowed SOCIAL_REASON.");
    }
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
    totalChildren += 1;
    taskWave.set(input.callID, wave);
    const memoRule = "\n\nReturn a public Markdown research memo with exact quotes and [S#] references. Do not return JSON, claim IDs, facet keys, verdicts, or source-authority labels.";
    if (typeof output.args?.prompt === "string") output.args.prompt += memoRule;
    else if (typeof output.args?.description === "string") output.args.description += memoRule;
  },
  "tool.execute.after": async (input, output) => {
    if (input.tool !== "task") return;
    const role = input.args?.subagent_type;
    if (!specialistRoles.includes(role)) return;
    const sessionId = typeof output.metadata?.sessionId === "string" ? output.metadata.sessionId : input.callID;
    const memo = typeof output.output === "string" && output.output.trim() ? output.output.trim() : "No usable public memo was returned; treat this scope as an explicit unresolved research limitation.";
    await mkdir("/workspace/case/.work/memos", { recursive: true });
    await writeFile(`/workspace/case/.work/memos/${safeName(role)}-${safeName(sessionId)}.md`, `# ${role} memo\n\nWave: ${taskWave.get(input.callID) ?? "UNKNOWN"}\nSession: ${sessionId}\n\n${memo}\n`, { mode: 0o600 });
    taskWave.delete(input.callID);
  },
  "experimental.session.compacting": async (_input, output) => {
    const response = await fetch(`${gatewayUrl}/internal/sources/index`, {
      headers: { authorization: `Bearer ${token}`, "x-run-id": runId, "x-opencode-agent": "lead-researcher" },
      signal: AbortSignal.timeout(10_000),
    });
    const sourceIndex = response.ok ? await response.text() : "Source index unavailable; retain existing S references and do not refetch merely to recover them.";
    const counts = Object.fromEntries(specialistRoles.map((role) => [role, roleCounts.get(role) ?? 0]));
    output.context.push(`Headless recovery context:\n- Objective: complete the current research checklist and return a consolidated memo.\n- Child invocation counts: ${JSON.stringify(counts)}\n- Remaining wave: ${targetedStarted ? "none; targeted wave already began" : "one targeted wave if a material exact gap remains"}\n- Hard deadline: ${deadlineAt ?? "host controlled"}\n- Re-read native todo state for completed and remaining checklist entries.\n- Source index: ${sourceIndex.slice(0, 120_000)}\nNever repeat a provider call merely to recover an S reference; use source.excerpts.`);
  },
});

export default plugin;
