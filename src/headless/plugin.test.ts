import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { tool } from "@opencode-ai/plugin";

process.env.CASE_GATEWAY_URL = "http://gateway.test";
process.env.CASE_TOKEN = "test-token";
process.env.RUN_ID = "test-run";
process.env.CASE_DEADLINE_AT = "2026-08-11T20:00:00.000Z";
process.env.CASE_ROOT = join(tmpdir(), `translucid-plugin-${process.pid}`);

after(async () => rm(process.env.CASE_ROOT!, { recursive: true, force: true }));

test("compaction context preserves refs and route history and directs v3 state recovery", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { tool: string; arguments?: unknown; operational: { sessionId: string } };
    if (body.tool === "research.state.set") return new Response(JSON.stringify({ ok: true, claimCount: 1, sourceRefs: ["S1", "S2", "S3"] }));
    if (body.tool === "source.inventory") return new Response(JSON.stringify({ sources: [{ ref: "S1" }, { ref: "S2" }, { ref: "S3" }], nextCursor: null }));
    return new Response(JSON.stringify({ sourceRefs: ["S1", "S3"], evidenceEligibleSourceRefs: ["S3"] }));
  };
  try {
    const { default: plugin } = await import("../../runtime/headless-opencode/plugin/translucid.ts");
    const hooks = await plugin({} as Parameters<typeof plugin>[0]);
    const chat = hooks["chat.message"]!;
    const compact = hooks["experimental.session.compacting"]!;
    const search = hooks.tool!["web.search"]!;
    const state = hooks.tool!["research.state.set"]!;
    await chat({ sessionID: "session-one" }, { message: {} as never, parts: [{ type: "text", text: "Investigate candidate chronology" }] as never });
    await search.execute({ query: "first query", mode: "fast", resultLimit: 10 }, { sessionID: "session-one", agent: "lead-researcher", abort: new AbortController().signal } as never);
    await state.execute({ publicationReady: true, claims: [{ id: "F001", claim: "A claim", provisionalStatus: "established", supportingRefs: ["S3"], conflictingRefs: [], remainingGap: null, importance: "material" }], identityAnchors: ["candidate@example.test"] }, { sessionID: "session-one", agent: "lead-researcher", abort: new AbortController().signal } as never);
    const output = { context: [] as string[] };
    await compact({ sessionID: "session-one" }, output);
    const text = output.context.join("\n");
    assert.match(text, /S1/);
    assert.match(text, /S3/);
    assert.match(text, /investigation\.progress\.get/);
    assert.doesNotMatch(text, /Latest claim state:/);
    assert.match(text, /web\.search/);
    assert.ok(Buffer.byteLength(text, "utf8") <= 8 * 1024);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web fetch forwards optional focus and the plugin forwards material search controls", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ tool: string; arguments?: Record<string, unknown> }> = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { tool: string; arguments?: Record<string, unknown> };
    calls.push(body);
    return new Response(JSON.stringify({ sourceRefs: ["S1"], evidenceEligibleSourceRefs: ["S1"] }));
  };
  try {
    const { default: plugin } = await import("../../runtime/headless-opencode/plugin/translucid.ts");
    const hooks = await plugin({} as Parameters<typeof plugin>[0]);
    const searchValues = tool.schema.object(hooks.tool!["web.search"]!.args).parse({ query: "ten results", mode: "deep", resultLimit: 10, additionalQueries: ["ten results history"], excludeDomains: ["LinkedIn.COM"], startPublishedDate: "2020-01-01T00:00:00Z", endPublishedDate: "2021-01-01T00:00:00.000Z" });
    await hooks.tool!["web.search"]!.execute(searchValues, { sessionID: "search-session", agent: "lead-researcher", abort: new AbortController().signal } as never);
    await hooks.tool!["web.fetch"]!.execute({ url: "https://example.test/record", focus: "employment date" }, { sessionID: "fetch-session", agent: "lead-researcher", abort: new AbortController().signal } as never);
    assert.equal(calls[0]?.arguments?.resultLimit, 10);
    assert.deepEqual(calls[0]?.arguments?.additionalQueries, ["ten results history"]);
    assert.deepEqual(calls[0]?.arguments?.excludeDomains, ["linkedin.com"]);
    assert.equal(calls[0]?.arguments?.startPublishedDate, "2020-01-01T00:00:00.000Z");
    assert.equal(calls[0]?.arguments?.endPublishedDate, "2021-01-01T00:00:00.000Z");
    assert.equal(calls[1]?.arguments?.focus, "employment date");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("plugin web search defaults to ten highlighted discovery results", async () => {
  const originalFetch = globalThis.fetch;
  let captured: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { arguments?: Record<string, unknown> };
    captured = body.arguments;
    return new Response(JSON.stringify({ sourceRefs: [] }));
  };
  try {
    const { default: plugin } = await import("../../runtime/headless-opencode/plugin/translucid.ts");
    const hooks = await plugin({} as Parameters<typeof plugin>[0]);
    const search = hooks.tool!["web.search"]!;
    const values = tool.schema.object(search.args).parse({ query: "five results" });
    await search.execute(values, { sessionID: "default-search", agent: "lead-researcher", abort: new AbortController().signal } as never);
    assert.equal(captured?.resultLimit, 10);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("plugin finding and summary schemas report compact word overflows", async () => {
  const { default: plugin } = await import("../../runtime/headless-opencode/plugin/translucid.ts");
  const hooks = await plugin({} as Parameters<typeof plugin>[0]);
  const findingSchema = tool.schema.object(hooks.tool!["investigation.finding.upsert"]!.args);
  const summarySchema = tool.schema.object(hooks.tool!["investigation.summary.set"]!.args);
  const words = (count: number) => Array.from({ length: count }, (_, index) => `word${index}`).join(" ");
  assert.throws(() => findingSchema.parse({ targetId: "target", conclusion: words(91), status: "ESTABLISHED", evidence: [], rationale: "Direct record.", remainingGap: null }), /conclusion.*91.*90/i);
  assert.throws(() => summarySchema.parse({ text: words(221), targetIds: [] }), /summary text.*221.*220/i);
});
