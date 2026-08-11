import assert from "node:assert/strict";
import test from "node:test";

process.env.CASE_GATEWAY_URL = "http://gateway.test";
process.env.CASE_TOKEN = "test-token";
process.env.RUN_ID = "test-run";
process.env.CASE_DEADLINE_AT = "2026-08-11T20:00:00.000Z";

test("compaction context is bounded and contains only the session's encountered source refs", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { operational: { sessionId: string } };
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

    await chat({ sessionID: "session-one" }, { message: {} as never, parts: [{ type: "text", text: "Investigate one ".repeat(1_000) }] as never });
    await chat({ sessionID: "session-two" }, { message: {} as never, parts: [{ type: "text", text: "Investigate two" }] as never });
    await search.execute({ query: "first query", mode: "fast", resultLimit: 5 }, { sessionID: "session-one", agent: "professional-researcher", abort: new AbortController().signal } as never);
    await search.execute({ query: "second query", mode: "fast", resultLimit: 5 }, { sessionID: "session-two", agent: "web-records-researcher", abort: new AbortController().signal } as never);

    const first = { context: [] as string[] };
    const second = { context: [] as string[] };
    await compact({ sessionID: "session-one" }, first);
    await compact({ sessionID: "session-two" }, second);
    const firstText = first.context.join("\n");
    const secondText = second.context.join("\n");

    assert.ok(Buffer.byteLength(firstText, "utf8") <= 8 * 1024);
    assert.match(firstText, /S1/);
    assert.match(firstText, /S3/);
    assert.doesNotMatch(firstText, /S2/);
    assert.match(secondText, /S2/);
    assert.doesNotMatch(secondText, /S1|S3/);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
});

test("empty OpenCode task-result envelopes are not completed memo handoffs", async () => {
  const { completedTaskMemo } = await import("../../runtime/headless-opencode/plugin/translucid.ts");

  assert.equal(completedTaskMemo("<task id=\"child\" state=\"completed\"><task_result>\n\n</task_result></task>"), undefined);
  assert.match(completedTaskMemo("<task id=\"child\" state=\"completed\"><task_result>Finding [S1].</task_result></task>") ?? "", /Finding \[S1\]/);
});
