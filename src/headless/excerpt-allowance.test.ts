import assert from "node:assert/strict";
import test from "node:test";

import { SessionExcerptAllowances } from "./excerpt-allowance.ts";

function result(maximum: number, truncated = false) {
  return { sourceRef: "S1", excerpts: [{ ref: "Xfixture", path: "$", offsetStart: 0, offsetEnd: maximum, text: "x".repeat(maximum) }], truncated };
}

test("accounts repeated requests cumulatively and reports explicit exhaustion", async () => {
  const allowances = new SessionExcerptAllowances();
  allowances.register("publishing", 10);
  let loads = 0;
  const load = async (maximum: number) => { loads += 1; return result(maximum); };

  assert.deepEqual(await allowances.execute("publishing", "S1", 6, load), {
    ...result(6),
    returnedCharacters: 6,
    remainingCharacters: 4,
    budgetExhausted: false,
  });
  assert.deepEqual(await allowances.execute("publishing", "S1", 6, load), {
    ...result(4),
    returnedCharacters: 4,
    remainingCharacters: 0,
    truncated: true,
    budgetExhausted: true,
  });
  const exhausted = await allowances.execute("publishing", "S1", 6, load);
  assert.equal(exhausted.returnedCharacters, 0);
  assert.equal(exhausted.remainingCharacters, 0);
  assert.equal(exhausted.budgetExhausted, true);
  assert.equal(loads, 2);
});

test("serializes parallel requests per session without sharing allowance across sessions", async () => {
  const allowances = new SessionExcerptAllowances();
  allowances.register("audit-a", 7);
  allowances.register("audit-b", 5);
  const load = async (maximum: number) => result(maximum);

  const [first, second, other] = await Promise.all([
    allowances.execute("audit-a", "S1", 5, load),
    allowances.execute("audit-a", "S1", 5, load),
    allowances.execute("audit-b", "S1", 5, load),
  ]);

  assert.equal(first.returnedCharacters + second.returnedCharacters, 7);
  assert.equal(second.remainingCharacters, 0);
  assert.equal(other.returnedCharacters, 5);
  assert.equal(other.remainingCharacters, 0);
});

test("preserves backend truncation and leaves unregistered research sessions uncapped", async () => {
  const allowances = new SessionExcerptAllowances();
  allowances.register("audit", 30);
  const truncated = await allowances.execute("audit", "S1", 10, async (maximum) => result(maximum, true));
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.remainingCharacters, 20);

  const research = await allowances.execute("research", "S1", 12, async (maximum) => result(maximum));
  assert.equal(research.returnedCharacters, 12);
  assert.equal(research.remainingCharacters, null);
  assert.equal(research.budgetExhausted, false);
});

test("a zero-character encoder allowance returns no source bytes and never calls the store", async () => {
  const allowances = new SessionExcerptAllowances();
  allowances.register("encoder", 0);
  let called = false;
  const denied = await allowances.execute("encoder", "S1", 60_000, async (maximum) => {
    called = true;
    return result(maximum);
  });
  assert.equal(called, false);
  assert.deepEqual(denied, {
    sourceRef: "S1",
    excerpts: [],
    returnedCharacters: 0,
    remainingCharacters: 0,
    truncated: true,
    budgetExhausted: true,
  });
});
