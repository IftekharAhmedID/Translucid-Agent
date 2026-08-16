import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

process.env.CASE_GATEWAY_URL = "http://gateway.test";
process.env.CASE_TOKEN = "test-token";
process.env.RUN_ID = "test-run";
process.env.CASE_DEADLINE_AT = "2026-08-11T20:00:00.000Z";
process.env.CASE_ROOT = join(tmpdir(), `translucid-plugin-${process.pid}`);

after(async () => rm(process.env.CASE_ROOT!, { recursive: true, force: true }));

test("compaction context is bounded and contains only the session's encountered source refs", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { tool: string; arguments?: { sourceRef?: string }; operational: { sessionId: string } };
    if (body.tool === "source.excerpts") return new Response(JSON.stringify({ sourceRef: body.arguments?.sourceRef, excerpts: [], truncated: false }));
    return new Response(JSON.stringify({
      sourceRefs: body.operational.sessionId === "session-one" ? ["S1", "S3"] : ["S2"],
      evidenceEligibleSourceRefs: body.operational.sessionId === "session-one" ? ["S3"] : [],
    }));
  };

  try {
    const { default: plugin } = await import("../../runtime/headless-opencode/plugin/translucid.ts");
    const hooks = await plugin({} as Parameters<typeof plugin>[0]);
    const chat = hooks["chat.message"]!;
    const compact = hooks["experimental.session.compacting"]!;
    const search = hooks.tool!["web.search"]!;
    const excerpts = hooks.tool!["source.excerpts"]!;

    await chat({ sessionID: "session-one" }, { message: {} as never, parts: [{ type: "text", text: "Investigate one ".repeat(1_000) }] as never });
    await chat({ sessionID: "session-two" }, { message: {} as never, parts: [{ type: "text", text: "Investigate two" }] as never });
    await search.execute({ query: "first query", mode: "fast", resultLimit: 5 }, { sessionID: "session-one", agent: "professional-researcher", abort: new AbortController().signal } as never);
    await search.execute({ query: "second query", mode: "fast", resultLimit: 5 }, { sessionID: "session-two", agent: "web-records-researcher", abort: new AbortController().signal } as never);
    await excerpts.execute({ sourceRef: "S7", queries: ["missing"] }, { sessionID: "session-one", agent: "professional-researcher", abort: new AbortController().signal } as never);

    const first = { context: [] as string[] };
    const second = { context: [] as string[] };
    await compact({ sessionID: "session-one" }, first);
    await compact({ sessionID: "session-two" }, second);
    const firstText = first.context.join("\n");
    const secondText = second.context.join("\n");

    assert.ok(Buffer.byteLength(firstText, "utf8") <= 8 * 1024);
    assert.match(firstText, /S1/);
    assert.match(firstText, /S3/);
    assert.match(firstText, /S7/);
    assert.doesNotMatch(firstText, /S2/);
    assert.match(secondText, /S2/);
    assert.doesNotMatch(secondText, /S1|S3/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web search plugin forwards deep mode unchanged", async () => {
  const originalFetch = globalThis.fetch;
  const modes: unknown[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { tool: string; arguments?: { mode?: unknown } };
    if (body.tool === "web.search") modes.push(body.arguments?.mode);
    return new Response(JSON.stringify({ sourceRefs: ["S1"], evidenceEligibleSourceRefs: ["S1"] }));
  };

  try {
    const { default: plugin } = await import("../../runtime/headless-opencode/plugin/translucid.ts");
    const hooks = await plugin({} as Parameters<typeof plugin>[0]);
    await hooks.tool!["web.search"]!.execute({ query: "deep search", mode: "deep", resultLimit: 5 }, { sessionID: "deep-session", agent: "lead-researcher", abort: new AbortController().signal } as never);
    assert.deepEqual(modes, ["deep"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("repairs an invalid memo once in the same child session without provider calls or task quota", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { tool: string; arguments?: { sourceRef?: string } };
    calls.push(body.tool);
    if (body.tool === "source.excerpts") return new Response(JSON.stringify({ sourceRef: body.arguments?.sourceRef, excerpts: [], truncated: false }));
    return new Response("{}");
  };

  try {
    await mkdir(join(process.env.CASE_ROOT!, ".work", "memos"), { recursive: true });
    const { default: plugin } = await import("../../runtime/headless-opencode/plugin/translucid.ts");
    const hooks = await plugin({} as Parameters<typeof plugin>[0]);
    const before = hooks["tool.execute.before"]!;
    const afterTask = hooks["tool.execute.after"]!;
    const initial = { args: { subagent_type: "professional-researcher", prompt: "WAVE: INITIAL\nVerify employment chronology.", background: true } };
    await before({ tool: "task", sessionID: "lead-session", callID: "task-call-1" }, initial);

    const rejected = { title: "professional research", output: "<task id=\"child-1\" state=\"completed\"><task_result>\n\n</task_result></task>", metadata: { sessionId: "child-1" } };
    await afterTask({ tool: "task", sessionID: "lead-session", callID: "task-call-1", args: initial.args }, rejected);
    assert.match(rejected.output, /task_id.*child-1/i);

    const repair = { args: { subagent_type: "professional-researcher", task_id: "child-1", prompt: "WAVE: INITIAL\nRepair the memo.", background: true } };
    await before({ tool: "task", sessionID: "lead-session", callID: "task-repair-1" }, repair);
    assert.equal(repair.args.background, false);
    assert.match(repair.args.prompt, /full, self-contained replacement memo/i);
    assert.match(repair.args.prompt, /Verify employment chronology/);

    const callsBeforeDeniedProvider = calls.length;
    await assert.rejects(
      hooks.tool!["web.search"]!.execute({ query: "must not run", mode: "fast", resultLimit: 5 }, { sessionID: "child-1", agent: "professional-researcher", abort: new AbortController().signal } as never),
      /repair mode denies web\.search/i,
    );
    assert.equal(calls.length, callsBeforeDeniedProvider);
    await hooks.tool!["source.excerpts"]!.execute({ sourceRef: "S7", queries: ["employment"] }, { sessionID: "child-1", agent: "professional-researcher", abort: new AbortController().signal } as never);

    await afterTask(
      { tool: "task", sessionID: "lead-session", callID: "task-repair-1", args: repair.args },
      { title: "professional research", output: "<task id=\"child-1\" state=\"completed\"><task_result>Employment evidence [S7].</task_result></task>", metadata: { sessionId: "child-1" } },
    );
    assert.match(await readFile(join(process.env.CASE_ROOT!, ".work", "memos", "professional-researcher-child-1.md"), "utf8"), /Employment evidence \[S7\]/);

    const targeted = { args: { subagent_type: "professional-researcher", prompt: "WAVE: TARGETED\nResolve one remaining gap.", background: true } };
    await before({ tool: "task", sessionID: "lead-session", callID: "task-call-2" }, targeted);
    await assert.rejects(before(
      { tool: "task", sessionID: "lead-session", callID: "task-repair-2" },
      { args: { subagent_type: "professional-researcher", task_id: "child-1", prompt: "WAVE: INITIAL\nTry again." } },
    ), /no pending memo repair|already used/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unknown memo citations enter the same bounded repair path", async () => {
  const { default: plugin } = await import("../../runtime/headless-opencode/plugin/translucid.ts");
  const hooks = await plugin({} as Parameters<typeof plugin>[0]);
  const before = hooks["tool.execute.before"]!;
  const afterTask = hooks["tool.execute.after"]!;
  const initial = { args: { subagent_type: "github-researcher", prompt: "WAVE: INITIAL\nVerify public repositories.", background: true } };
  await before({ tool: "task", sessionID: "lead-session", callID: "github-call-1" }, initial);
  const rejected = { title: "github research", output: "<task_result>Uninspected evidence [S99].</task_result>", metadata: { sessionId: "github-child-1" } };

  await afterTask({ tool: "task", sessionID: "lead-session", callID: "github-call-1", args: initial.args }, rejected);

  assert.match(rejected.output, /task_id github-child-1/i);
  const diagnostic = JSON.parse(await readFile(join(process.env.CASE_ROOT!, ".work", "memos", "rejected-github-researcher-github-child-1-attempt-1.json"), "utf8"));
  assert.equal(diagnostic.failureKind, "UNKNOWN_SOURCE_REFS");
  assert.deepEqual(diagnostic.unknownSourceRefs, ["S99"]);
  await before(
    { tool: "task", sessionID: "lead-session", callID: "github-repair-1" },
    { args: { subagent_type: "github-researcher", task_id: "github-child-1", prompt: "WAVE: INITIAL\nRepair citations." } },
  );
});

test("exposes the five native lean report tools", async () => {
  const { default: plugin } = await import("../../runtime/headless-opencode/plugin/translucid.ts");
  const hooks = await plugin({} as Parameters<typeof plugin>[0]);
  const names = Object.keys(hooks.tool ?? {}).filter((name) => name.startsWith("report.")).sort();
  assert.deepEqual(names, [
    "report.finalize",
    "report.finding.remove",
    "report.finding.upsert",
    "report.progress.get",
    "report.summary.set",
  ]);
});

test("specialist tasks are forced to complete before their memo handoff", async () => {
  const { default: plugin } = await import("../../runtime/headless-opencode/plugin/translucid.ts");
  const hooks = await plugin({} as Parameters<typeof plugin>[0]);
  const before = hooks["tool.execute.before"]!;
  const output = {
    args: {
      subagent_type: "professional-researcher",
      prompt: "WAVE: INITIAL\nVerify the candidate's employment chronology.",
      background: true,
    },
  };

  await before({ tool: "task", sessionID: "lead-session", callID: "task-call-1" }, output);

  assert.equal(output.args.background, false);
  assert.match(output.args.prompt, /complete material handoff/i);
  assert.match(output.args.prompt, /materially useful observation/i);
  assert.match(output.args.prompt, /negative finding/i);
});

test("empty OpenCode task-result envelopes are not completed memo handoffs", async () => {
  const { completedTaskMemo } = await import("../../runtime/headless-opencode/plugin/task-memo.ts");

  assert.equal(completedTaskMemo("<task id=\"child\" state=\"completed\"><task_result>\n\n</task_result></task>"), undefined);
  assert.match(completedTaskMemo("<task id=\"child\" state=\"completed\"><task_result>Finding [S1].</task_result></task>") ?? "", /Finding \[S1\]/);
});

test("specialist memo citations must come from that session's encountered source union", async () => {
  const { validateMemoCitations } = await import("../../runtime/headless-opencode/plugin/translucid.ts");
  assert.deepEqual(validateMemoCitations("Finding [S1] and [S3].", ["S1", "S2"]), {
    citedSourceRefs: ["S1", "S3"],
    unknownSourceRefs: ["S3"],
  });
});
