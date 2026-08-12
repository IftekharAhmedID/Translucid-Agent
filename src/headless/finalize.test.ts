import assert from "node:assert/strict";
import test from "node:test";

import { finalizeWithSingleRepair } from "./finalize.ts";

type Dossier = { version: number; defects?: string[] };
type Draft = { version: number; dossierVersion: number; defects?: string[] };
type Result = { result: number };

function validInputs(overrides: Partial<Parameters<typeof finalizeWithSingleRepair<Dossier, Draft, Result>>[0]> = {}) {
  return {
    createDossier: async ({ attempt }: { attempt: 1 | 2 }) => ({ version: attempt }),
    encode: async ({ attempt, dossier }: { attempt: 1 | 2; dossier: Dossier }) => ({ version: attempt, dossierVersion: dossier.version }),
    validateEncoding: async () => undefined,
    validateResult: async (draft: Draft) => ({ result: draft.version }),
    audit: async () => ({ status: "PASSED" as const, defects: [] }),
    ...overrides,
  };
}

test("returns the first lossless, deterministically valid, independently audited encoding", async () => {
  const calls: string[] = [];
  const finalized = await finalizeWithSingleRepair<Dossier, Draft, Result>(validInputs({
    createDossier: async ({ attempt }) => { calls.push(`dossier-${attempt}`); return { version: attempt }; },
    encode: async ({ attempt, dossier }) => { calls.push(`encode-${attempt}`); return { version: attempt, dossierVersion: dossier.version }; },
    validateEncoding: async (_dossier, draft) => { calls.push(`lossless-${draft.version}`); },
    validateResult: async (draft) => { calls.push(`validate-${draft.version}`); return { result: draft.version }; },
    audit: async (_result, _dossier, attempt) => { calls.push(`audit-${attempt}`); return { status: "PASSED", defects: [] }; },
  }));

  assert.deepEqual(finalized, {
    dossier: { version: 1 },
    draft: { version: 1, dossierVersion: 1 },
    result: { result: 1 },
    compilerAttempts: 1,
    auditorAttempts: 1,
  });
  assert.deepEqual(calls, ["dossier-1", "encode-1", "lossless-1", "validate-1", "audit-1"]);
});

test("routes encoder schema and losslessness defects to an encoder-only repair", async () => {
  for (const defectAt of ["schema", "losslessness"] as const) {
    const calls: string[] = [];
    const finalized = await finalizeWithSingleRepair<Dossier, Draft, Result>(validInputs({
      createDossier: async ({ attempt }) => { calls.push(`dossier-${attempt}`); return { version: attempt }; },
      encode: async ({ attempt, dossier, defects }) => {
        calls.push(`encode-${attempt}`);
        if (defectAt === "schema" && attempt === 1) throw new Error("invalid JSON schema");
        return { version: attempt, dossierVersion: dossier.version, defects };
      },
      validateEncoding: async (_dossier, draft) => {
        calls.push(`lossless-${draft.version}`);
        if (defectAt === "losslessness" && draft.version === 1) throw new Error("claim wording changed");
      },
    }));

    assert.equal(finalized.compilerAttempts, 2);
    assert.equal(finalized.dossier.version, 1);
    assert.equal(finalized.draft.version, 2);
    assert.deepEqual(calls.filter((call) => call.startsWith("dossier")), ["dossier-1"]);
    assert.match(finalized.draft.defects?.[0] ?? "", defectAt === "schema" ? /encoder schema.*invalid JSON/i : /losslessness.*claim wording/i);
  }
});

test("routes deterministic semantic defects to a dossier repair followed by fresh encoding", async () => {
  const calls: string[] = [];
  const finalized = await finalizeWithSingleRepair<Dossier, Draft, Result>(validInputs({
    createDossier: async ({ attempt, defects }) => { calls.push(`dossier-${attempt}`); return { version: attempt, defects }; },
    encode: async ({ attempt, dossier }) => { calls.push(`encode-${attempt}-d${dossier.version}`); return { version: attempt, dossierVersion: dossier.version }; },
    validateResult: async (draft) => {
      if (draft.dossierVersion === 1) throw new Error("exact quote not present");
      return { result: draft.version };
    },
  }));

  assert.equal(finalized.compilerAttempts, 2);
  assert.equal(finalized.dossier.version, 2);
  assert.match(finalized.dossier.defects?.[0] ?? "", /deterministic validation.*exact quote/i);
  assert.deepEqual(calls, ["dossier-1", "encode-1-d1", "dossier-2", "encode-2-d2"]);
});

test("routes a material audit defect to dossier repair and requires a fresh passing audit", async () => {
  const calls: string[] = [];
  const finalized = await finalizeWithSingleRepair<Dossier, Draft, Result>(validInputs({
    createDossier: async ({ attempt, defects }) => { calls.push(`dossier-${attempt}`); return { version: attempt, defects }; },
    encode: async ({ attempt, dossier }) => { calls.push(`encode-${attempt}`); return { version: attempt, dossierVersion: dossier.version }; },
    audit: async (_result, _dossier, attempt) => {
      calls.push(`audit-${attempt}`);
      return attempt === 1
        ? { status: "REPAIR_REQUIRED", defects: ["Timeline evidence crosses a claim boundary."] }
        : { status: "PASSED", defects: [] };
    },
  }));

  assert.equal(finalized.compilerAttempts, 2);
  assert.equal(finalized.auditorAttempts, 2);
  assert.match(finalized.dossier.defects?.[0] ?? "", /timeline evidence/i);
  assert.deepEqual(calls, ["dossier-1", "encode-1", "audit-1", "dossier-2", "encode-2", "audit-2"]);
});

test("a dossier parse failure consumes the sole repair before encoding", async () => {
  const finalized = await finalizeWithSingleRepair<Dossier, Draft, Result>(validInputs({
    createDossier: async ({ attempt, defects }) => {
      if (attempt === 1) throw new Error("dangling source reference");
      return { version: attempt, defects };
    },
  }));
  assert.equal(finalized.compilerAttempts, 2);
  assert.match(finalized.dossier.defects?.[0] ?? "", /dossier validation.*dangling source/i);
});

test("fails closed when any material defect remains after the single repair", async () => {
  await assert.rejects(finalizeWithSingleRepair<Dossier, Draft, Result>(validInputs({
    encode: async ({ attempt, dossier }) => {
      if (attempt === 1) throw new Error("bad schema");
      return { version: attempt, dossierVersion: dossier.version };
    },
    validateResult: async () => { throw new Error("invalid exact quote"); },
  })), /deterministic validation failed after the single repair.*invalid exact quote/i);

  await assert.rejects(finalizeWithSingleRepair<Dossier, Draft, Result>(validInputs({
    validateResult: async (draft) => {
      if (draft.dossierVersion === 1) throw new Error("invalid exact quote");
      return { result: draft.version };
    },
    audit: async () => ({ status: "REPAIR_REQUIRED", defects: ["Material assertion omitted."] }),
  })), /audit failed after the single repair.*Material assertion omitted/i);
});
