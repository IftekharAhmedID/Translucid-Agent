import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeFindingBatches,
  partitionClaims,
  promptStructured,
  validateFindingBatch,
} from "./finalization.ts";

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
