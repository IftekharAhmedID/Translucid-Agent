import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

import { completedTaskMemo } from "./task-memo.ts";

const z = tool.schema;
const gatewayUrl = process.env.CASE_GATEWAY_URL;
const token = process.env.CASE_TOKEN;
const runId = process.env.RUN_ID;
const deadlineAt = process.env.CASE_DEADLINE_AT;
const caseRoot = process.env.CASE_ROOT ?? "/workspace/case";

if (!gatewayUrl || !token || !runId) throw new Error("Headless run gateway environment is incomplete.");
const configuredGatewayUrl = gatewayUrl;
const configuredToken = token;
const configuredRunId = runId;

const specialistRoles = ["professional-researcher", "github-researcher", "web-records-researcher", "social-researcher"] as const;
type SpecialistRole = (typeof specialistRoles)[number];
type Wave = "INITIAL" | "TARGETED";
type PendingRepair = { role: SpecialistRole; wave: Wave; assignment: string; repairUsed: boolean };

function specialistRole(value: unknown): value is SpecialistRole {
  return typeof value === "string" && specialistRoles.some((role) => role === value);
}

function taskPrompt(args: Record<string, unknown>): string {
  return typeof args.prompt === "string" ? args.prompt : typeof args.description === "string" ? args.description : "";
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
}

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
      .filter((value): value is string => typeof value === "string" && /^S[1-9]\d*$/.test(value));
    return [...new Set(refs)]
      .sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
  } catch {
    return [];
  }
}

function citedMemoRefs(memo: string): string[] {
  return [...new Set([...memo.matchAll(/\bS([1-9]\d*)\b/g)].map((match) => `S${match[1]}`))]
    .sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
}

export function validateMemoCitations(memo: string, encounteredSourceRefs: Iterable<string>): { citedSourceRefs: string[]; unknownSourceRefs: string[] } {
  const citedSourceRefs = citedMemoRefs(memo);
  const encountered = new Set(encounteredSourceRefs);
  return { citedSourceRefs, unknownSourceRefs: citedSourceRefs.filter((ref) => !encountered.has(ref)) };
}

const plugin: Plugin = async () => {
  const roleCounts = new Map<string, number>();
  const taskWave = new Map<string, Wave>();
  const taskAssignments = new Map<string, string>();
  const repairCalls = new Map<string, string>();
  const pendingRepairs = new Map<string, PendingRepair>();
  const repairSessions = new Set<string>();
  const assignments = new Map<string, string>();
  const sessionSourceRefs = new Map<string, Set<string>>();
  let totalChildren = 0;
  let targetedChildren = 0;
  let targetedStarted = false;

  async function execute(name: string, args: unknown, context: { sessionID: string; agent: string; callID?: string; abort: AbortSignal }) {
    if (repairSessions.has(context.sessionID) && name !== "source.excerpts") {
      throw new Error(`Memo repair mode denies ${name}; only source.excerpts is allowed.`);
    }
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
    return body;
  }

  function gatewayTool(
    name: string,
    description: string,
    args: Parameters<typeof tool>[0]["args"],
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
    "source.excerpts": gatewayTool("source.excerpts", "Search one immutable S reference locally for exact JSON scalar paths or bounded text windows without a network call.", { sourceRef: z.string().regex(/^S[1-9]\d*$/), queries: z.array(z.string().min(1).max(500)).min(1).max(12), maxCharacters: z.number().int().min(1).max(60000).optional() }),
    "report.summary.set": gatewayTool("report.summary.set", "Set or replace the single concise investigation summary after research is complete.", {
      summary: z.string().trim().min(1).max(50000),
    }),
    "report.finding.upsert": gatewayTool("report.finding.upsert", "Create or repair one coherent résumé finding. Reusing findingId updates it without creating a duplicate.", {
      findingId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
      section: z.string().trim().min(1).max(200),
      claim: z.string().trim().min(1).max(6000),
      anchor: z.object({
        kind: z.literal("PDF_TEXT"),
        page: z.number().int().positive(),
        lineStart: z.number().int().positive(),
        lineEnd: z.number().int().positive(),
        exact: z.string().trim().min(1).max(6000),
      }),
      evidence: z.string().trim().min(1).max(12000),
      notes: z.string().max(6000).optional(),
      status: z.union([z.literal(-2), z.literal(-1), z.literal(0), z.literal(1), z.literal(2)]),
      sourceRefs: z.array(z.string().regex(/^S[1-9]\d*$/)).max(200),
    }),
    "report.finding.remove": gatewayTool("report.finding.remove", "Remove one mistaken or superseded finding before finalization.", {
      findingId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
    }),
    "report.progress.get": gatewayTool("report.progress.get", "Read the durable report summary, ordered findings, revision, and state before continuing or finalizing.", {}),
    "report.finalize": gatewayTool("report.finalize", "Lock the report after reviewing résumé coverage. This is irreversible for the current run.", {}),
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
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "task") return;
      const role = output.args?.subagent_type;
      if (!specialistRole(role)) return;
      const prompt = taskPrompt(output.args ?? {});
      const wave = prompt.match(/\bWAVE:\s*(INITIAL|TARGETED)\b/i)?.[1]?.toLocaleUpperCase("en-US") as Wave | undefined;
      if (!wave) throw new Error("Every specialist task must declare WAVE: INITIAL or WAVE: TARGETED.");
      const repairSessionId = typeof output.args?.task_id === "string" ? output.args.task_id : undefined;
      if (repairSessionId) {
        const pending = pendingRepairs.get(repairSessionId);
        if (!pending) throw new Error(`Child ${repairSessionId} has no pending memo repair.`);
        if (pending.repairUsed) throw new Error(`Child ${repairSessionId} already used its one memo repair.`);
        if (role !== pending.role || wave !== pending.wave) throw new Error(`Memo repair for ${repairSessionId} must keep role ${pending.role} and wave ${pending.wave}.`);
        pending.repairUsed = true;
        repairCalls.set(input.callID, repairSessionId);
        repairSessions.add(repairSessionId);
        taskWave.set(input.callID, wave);
        output.args.background = false;
        const repairRule = `\n\nThis is the one allowed protocol repair for task_id ${repairSessionId}. Do not call provider or network tools; only source.excerpts may be used. Return a full, self-contained replacement memo for the original assignment, not a delta, correction, or reference to earlier output. Cite only S references encountered by this same child session.\n\nOriginal assignment:\n${pending.assignment}`;
        if (typeof output.args.prompt === "string") output.args.prompt += repairRule;
        else if (typeof output.args.description === "string") output.args.description += repairRule;
        return;
      }
      if (wave === "INITIAL" && targetedStarted) throw new Error("An initial task cannot start after the targeted wave.");
      if (wave === "TARGETED" && targetedChildren >= 2) throw new Error("The targeted wave has reached its two-child limit.");
      if ((roleCounts.get(role) ?? 0) >= 2) throw new Error(`${role} has already reached its two-invocation limit.`);
      if (totalChildren >= 8) throw new Error("The run has reached its eight-child research limit.");
      if (role === "social-researcher" && !/SOCIAL_REASON:\s*(EXPLICIT_SOCIAL_CLAIM|PUBLIC_IDENTITY_CROSS_LINK|MATERIAL_ACTIVITY_QUESTION)/.test(prompt)) {
        throw new Error("Social research requires one explicit allowed SOCIAL_REASON.");
      }
      if (wave === "TARGETED") {
        targetedStarted = true;
        targetedChildren += 1;
      }
      roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
      totalChildren += 1;
      taskWave.set(input.callID, wave);
      taskAssignments.set(input.callID, truncateUtf8(prompt, 16 * 1024));
      output.args.background = false;
      const memoRule = "\n\nReturn a public Markdown research memo with exact quotes and [S#] references. Do not return report records or scores.";
      if (typeof output.args?.prompt === "string") output.args.prompt += memoRule;
      else if (typeof output.args?.description === "string") output.args.description += memoRule;
    },
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "task") return;
      const role = input.args?.subagent_type;
      if (!specialistRole(role)) return;
      const sessionId = typeof output.metadata?.sessionId === "string" ? output.metadata.sessionId : input.callID;
      const repairSessionId = repairCalls.get(input.callID);
      if (repairSessionId && repairSessionId !== sessionId) throw new Error(`Memo repair resumed ${sessionId} instead of pending child ${repairSessionId}.`);
      const memo = completedTaskMemo(output.output);
      const wave = taskWave.get(input.callID) ?? "UNKNOWN";
      const assignment = repairSessionId
        ? pendingRepairs.get(repairSessionId)?.assignment ?? "Unavailable."
        : taskAssignments.get(input.callID) ?? "Unavailable.";
      taskWave.delete(input.callID);
      taskAssignments.delete(input.callID);
      repairCalls.delete(input.callID);
      await mkdir(`${caseRoot}/.work/memos`, { recursive: true });
      const encounteredSourceRefs = [...(sessionSourceRefs.get(sessionId) ?? new Set<string>())].sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
      const rejectedOutput = typeof output.output === "string" ? output.output : JSON.stringify(output.output ?? null);
      const citationCheck = memo ? validateMemoCitations(memo, encounteredSourceRefs) : { citedSourceRefs: [], unknownSourceRefs: [] };
      const failureKind = !memo ? "EMPTY_MEMO" : citationCheck.unknownSourceRefs.length ? "UNKNOWN_SOURCE_REFS" : undefined;
      if (failureKind) {
        const pending = pendingRepairs.get(sessionId) ?? { role, wave: wave === "UNKNOWN" ? "INITIAL" : wave, assignment, repairUsed: Boolean(repairSessionId) };
        pendingRepairs.set(sessionId, pending);
        const attempt = pending.repairUsed ? 2 : 1;
        const reason = failureKind === "EMPTY_MEMO"
          ? "the child returned no completed task-result memo"
          : `citation(s) ${citationCheck.unknownSourceRefs.join(", ")} were not returned to that specialist session`;
        const next = pending.repairUsed
          ? "No repair remains; the research handoff must fail before publishing."
          : `Resume this exact child once with subagent_type ${role}, task_id ${sessionId}, and WAVE: ${pending.wave}.`;
        const diagnostic = `Rejected ${role} memo for session ${sessionId}: ${reason}. ${next}`;
        output.output = diagnostic;
        await writeFile(`${caseRoot}/.work/memos/rejected-${safeName(role)}-${safeName(sessionId)}-attempt-${attempt}.json`, `${JSON.stringify({
          schemaVersion: 1,
          role,
          wave: pending.wave,
          sessionId,
          attempt,
          failureKind,
          unknownSourceRefs: citationCheck.unknownSourceRefs,
          encounteredSourceRefs,
          citedSourceRefs: citationCheck.citedSourceRefs,
          rejectedOutputSha256: createHash("sha256").update(rejectedOutput).digest("hex"),
          rejectedOutput: truncateUtf8(rejectedOutput, 4 * 1024),
          diagnostic,
        }, null, 2)}\n`, { mode: 0o600 });
        return;
      }
      if (repairSessionId) pendingRepairs.delete(sessionId);
      const { citedSourceRefs } = citationCheck;
      const memoFile = `# ${role} memo\n\nWave: ${wave}\nSession: ${sessionId}\n\n${memo}\n`;
      await writeFile(`${caseRoot}/.work/memos/${safeName(role)}-${safeName(sessionId)}.md`, memoFile, { mode: 0o600 });
      await writeFile(`${caseRoot}/.work/memos/${safeName(role)}-${safeName(sessionId)}.sources.json`, `${JSON.stringify({ schemaVersion: 1, role, wave, sessionId, memoSha256: createHash("sha256").update(memoFile).digest("hex"), encounteredSourceRefs, citedSourceRefs }, null, 2)}\n`, { mode: 0o600 });
      const persisted = await fetch(`${configuredGatewayUrl}/internal/tools/execute`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${configuredToken}`,
          "content-type": "application/json",
          "x-run-id": configuredRunId,
          "x-opencode-agent": role,
        },
        body: JSON.stringify({
          tool: "research.memo.persist",
          arguments: { role, wave, sessionId, memo: memoFile, encounteredSourceRefs, citedSourceRefs },
          operational: { sessionId, agent: role, callId: input.callID },
        }),
      });
      if (!persisted.ok) throw new Error(`Host rejected completed ${role} memo (${persisted.status}): ${(await persisted.text()).slice(0, 300)}`);
    },
    "experimental.session.compacting": async (input, output) => {
      const counts = Object.fromEntries(specialistRoles.map((role) => [role, roleCounts.get(role) ?? 0]));
      const refs = [...(sessionSourceRefs.get(input.sessionID) ?? [])].sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
      output.context.push(truncateUtf8(`Headless recovery context:\n- Initial assignment: ${assignments.get(input.sessionID) ?? "Unavailable; continue the current assigned scope."}\n- Child invocation counts: ${JSON.stringify(counts)}\n- Research children: ${totalChildren}; targeted children: ${targetedChildren}\n- Remaining wave: ${targetedStarted ? "none; targeted wave already began" : "one targeted wave if a material exact gap remains"}\n- Hard deadline: ${deadlineAt ?? "host controlled"}\n- This session's encountered source refs: ${refs.join(", ") || "none"}\nNever repeat a provider call merely to recover an S reference; use source.excerpts.`, 8 * 1024));
    },
  };
};

export default plugin;
