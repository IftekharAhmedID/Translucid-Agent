import assert from "node:assert/strict";
import test from "node:test";

import { finalizeWithSingleRepair } from "./finalize.ts";

type Draft = { version: number; defects?: string[] };
type Result = { result: number };

test("returns the first deterministically valid and independently audited draft", async () => {
  const calls: string[] = [];
  const finalized = await finalizeWithSingleRepair<Draft, Result>({
    compile: async ({ attempt }) => { calls.push(`compile-${attempt}`); return { version: attempt }; },
    validate: async (draft) => { calls.push(`validate-${draft.version}`); return { result: draft.version }; },
    audit: async (_result, attempt) => { calls.push(`audit-${attempt}`); return { status: "PASSED", defects: [] }; },
  });
  assert.deepEqual(finalized, { draft: { version: 1 }, result: { result: 1 }, compilerAttempts: 1, auditorAttempts: 1 });
  assert.deepEqual(calls, ["compile-1", "validate-1", "audit-1"]);
});

test("uses the sole repair for deterministic defects and still requires a passing audit", async () => {
  const finalized = await finalizeWithSingleRepair<Draft, Result>({
    compile: async ({ attempt, defects }) => ({ version: attempt, defects }),
    validate: async (draft) => {
      if (draft.version === 1) throw new Error("quote missing");
      return { result: draft.version };
    },
    audit: async () => ({ status: "PASSED", defects: [] }),
  });
  assert.equal(finalized.compilerAttempts, 2);
  assert.equal(finalized.auditorAttempts, 1);
  assert.match(finalized.draft.defects?.[0] ?? "", /quote missing/);
});

test("uses the sole repair when the first compiler response violates its schema", async () => {
  const finalized = await finalizeWithSingleRepair<Draft, Result>({
    compile: async ({ attempt, defects }) => {
      if (attempt === 1) throw new Error("summary evidenceKeys must contain at least one item");
      return { version: attempt, defects };
    },
    validate: async (draft) => ({ result: draft.version }),
    audit: async () => ({ status: "PASSED", defects: [] }),
  });
  assert.equal(finalized.compilerAttempts, 2);
  assert.match(finalized.draft.defects?.[0] ?? "", /compiler schema.*evidenceKeys/i);
});

test("uses the sole repair for audit defects and runs a fresh verification audit", async () => {
  const finalized = await finalizeWithSingleRepair<Draft, Result>({
    compile: async ({ attempt, defects }) => ({ version: attempt, defects }),
    validate: async (draft) => ({ result: draft.version }),
    audit: async (_result, attempt) => attempt === 1
      ? { status: "REPAIR_REQUIRED", defects: ["Timeline evidence crosses a claim boundary."] }
      : { status: "PASSED", defects: [] },
  });
  assert.equal(finalized.compilerAttempts, 2);
  assert.equal(finalized.auditorAttempts, 2);
  assert.deepEqual(finalized.draft.defects, ["Timeline evidence crosses a claim boundary."]);
});

test("fails instead of emitting output when a material defect remains after one repair", async () => {
  await assert.rejects(finalizeWithSingleRepair<Draft, Result>({
    compile: async ({ attempt }) => ({ version: attempt }),
    validate: async (draft) => {
      if (draft.version === 1) throw new Error("invalid quote");
      return { result: draft.version };
    },
    audit: async () => ({ status: "REPAIR_REQUIRED", defects: ["Material assertion omitted."] }),
  }), /audit failed after the single repair.*Material assertion omitted/i);
});
