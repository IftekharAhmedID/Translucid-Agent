import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  mergeFindingBatches,
  finalizeFrozenResearch,
  partitionClaims,
  promptStructured,
  validateFindingBatch,
} from "./finalization.ts";
import { ResearchStateStore } from "./research-state.ts";
import { ReportStore } from "./report-store.ts";
import { FileSourceStore } from "./source-store.ts";

const finding = (id: string) => ({
  findingId: id,
  section: "Career Experience",
  claim: `Claim ${id}`,
  anchor: { kind: "PDF_TEXT" as const, page: 1, lineStart: 1, lineEnd: 1, exact: "Synthetic Candidate" },
  evidence: `Evidence for ${id}.`,
  notes: "",
  status: 2 as const,
  sourceRefs: ["S1"],
  researchClaimIds: [id],
});

test("seventy-four frozen claims partition into fifteen ordered batches of at most five", () => {
  const claimIds = Array.from({ length: 74 }, (_, index) => `R${String(index + 1).padStart(3, "0")}`);
  const batches = partitionClaims(claimIds);

  assert.equal(batches.length, 15);
  assert.deepEqual(batches[0], ["R001", "R002", "R003", "R004", "R005"]);
  assert.deepEqual(batches.at(-1), ["R071", "R072", "R073", "R074"]);
});

test("a publication batch requires exactly one finding mapped to each frozen claim", () => {
  const expected = ["R001", "R002", "R003"];
  const valid = validateFindingBatch({ findings: expected.map(finding) }, expected);

  assert.deepEqual(valid.map(({ findingId }) => findingId), expected);
  assert.throws(() => validateFindingBatch({ findings: [finding("R001"), finding("R001"), finding("R003")] }, expected), /duplicate/i);
  assert.throws(() => validateFindingBatch({ findings: [finding("R001"), finding("R002")] }, expected), /missing/i);
  assert.throws(() => validateFindingBatch({ findings: [{ ...finding("R001"), researchClaimIds: ["R002"] }, finding("R002"), finding("R003")] }, expected), /researchClaimIds/i);
});

test("merged batches reject missing, duplicate, and unexpected frozen claim findings", () => {
  const expected = ["R001", "R002", "R003", "R004", "R005"];
  const batches = [[finding("R001"), finding("R002")], [finding("R003"), finding("R004"), finding("R005")]];

  assert.deepEqual(mergeFindingBatches(batches, expected).map(({ findingId }) => findingId), expected);
  assert.throws(() => mergeFindingBatches([[finding("R001")], [finding("R001")]], expected), /duplicate/i);
  assert.throws(() => mergeFindingBatches([[finding("R001")]], expected), /missing/i);
  assert.throws(() => mergeFindingBatches([[finding("R001"), finding("EXTRA")]], expected), /unexpected/i);
});

test("structured publication retries once with a fresh JSON-only session after native output fails", async () => {
  const calls: Array<{ title: string; native: boolean }> = [];
  let sessions = 0;
  const result = await promptStructured({
    title: "Publication batch 1 of 1",
    prompt: "Return the finding batch.",
    schema: {
      parse: (value: unknown) => {
        if (!value || typeof value !== "object" || (value as { ok?: unknown }).ok !== true) throw new Error("invalid value");
        return value as { ok: true };
      },
      jsonSchema: { type: "object", required: ["ok"], properties: { ok: { const: true } } },
    },
    createSession: async (title) => ({ id: `session-${++sessions}`, title }),
    send: async ({ sessionId, native }) => {
      calls.push({ title: sessionId, native });
      if (native) throw new Error("StructuredOutputError");
      return { info: { role: "assistant" }, parts: [{ type: "text", text: "{\"ok\":true}" }] };
    },
  });

  assert.deepEqual(result.value, { ok: true });
  assert.equal(result.sessionId, "session-2");
  assert.deepEqual(calls.map(({ native }) => native), [true, false]);
});

test("host finalization writes every frozen claim from local excerpts before setting the structured summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-finalization-"));
  try {
    await mkdir(join(root, "input"), { recursive: true });
    await writeFile(join(root, "input", "document.json"), JSON.stringify({
      schemaVersion: 1,
      pages: [{ page: 1, lines: [{ line: 1, text: "Synthetic Candidate" }], text: "Synthetic Candidate", sparse: false, links: [] }],
    }));
    const sourceStore = await FileSourceStore.open(root);
    const source = await sourceStore.capture({
      kind: "SOURCE_CONTENT",
      provider: "fixture",
      providerRoute: "fixture.source",
      sourceUrl: "https://example.test/synthetic",
      title: "Synthetic record",
      mimeType: "text/plain",
      content: {
        records: Array.from({ length: 6 }, (_, index) => ({
          evidence: `${"unrelated prefix ".repeat(160)} Synthetic role ${index + 1}`,
        })),
      },
      provenance: {},
    });
    const researchState = await ResearchStateStore.open(root, sourceStore);
    const claims = Array.from({ length: 6 }, (_, index) => ({
      id: `R${String(index + 1).padStart(3, "0")}`,
      claim: `Synthetic role ${index + 1}`,
      provisionalStatus: "established" as const,
      supportingRefs: [source.ref],
      conflictingRefs: [],
      remainingGap: null,
      importance: "material",
    }));
    await researchState.set({ publicationReady: true, identityAnchors: ["Synthetic Candidate"], claims });
    const reportStore = await ReportStore.open(root, {
      runId: "run-finalization",
      inputSha256: "a".repeat(64),
      startedAt: "2026-08-17T00:00:00.000Z",
      runtime: "LOCAL",
      model: "gpt-5.6-luna",
      sourceStore,
      researchState,
    });
    await reportStore.bindResearchSnapshot("b".repeat(64));
    const prompts: string[] = [];

    await finalizeFrozenResearch({
      root,
      sourceStore,
      researchState,
      reportStore,
      writer: {
        promptStructured: async ({ title, prompt }) => {
          prompts.push(prompt);
          if (title === "Publication summary") return { sessionId: "summary-session", value: { summary: "The synthetic source corroborates every listed role.", researchClaimIds: claims.map(({ id }) => id) } as never };
          const ids = [...prompt.matchAll(/"id":"(R\d+)"/g)].map((match) => match[1]!);
          return {
            sessionId: `${title}-session`,
            value: {
              findings: ids.map((id) => ({ ...finding(id), sourceRefs: [source.ref] })),
            } as never,
          };
        },
      },
    });

    const progress = await reportStore.progress();
    assert.equal(progress.state, "READY");
    assert.deepEqual(progress.findings.map(({ findingId }) => findingId).sort(), claims.map(({ id }) => id));
    assert.match(prompts[0]!, /localExcerpts/);
    const publicationPrompts = prompts.filter((prompt) => /"findings"/.test(prompt));
    assert.equal(publicationPrompts.length, 2);
    for (const claim of claims) assert.ok(publicationPrompts.some((prompt) => prompt.includes(`Synthetic role ${Number(claim.id.slice(1))}`)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
