import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRunBudget } from "./budget.ts";

test("enforces model, provider, network, and route ceilings atomically", async () => {
  const budget = new MemoryRunBudget({ modelUsd: 5, providerUsd: 10, externalNetworkCalls: 3, repositoryClones: 1, socialProfiles: 1 });
  await Promise.all([
    budget.recordNetworkCall("web.fetch"),
    budget.recordNetworkCall("web.fetch"),
    budget.recordNetworkCall("github.clone"),
  ]);
  budget.reserveModel(1.25);
  budget.recordProvider(2.5);

  assert.deepEqual(budget.snapshot(), {
    modelUsd: 1.25,
    providerUsd: 2.5,
    externalNetworkCalls: 3,
    routeCounts: { "github.clone": 1, "web.fetch": 2 },
  });
  await assert.rejects(() => budget.recordNetworkCall("web.fetch"), /external network call budget/i);

  const routeBudget = new MemoryRunBudget({ modelUsd: 5, providerUsd: 10, externalNetworkCalls: 10, repositoryClones: 1, socialProfiles: 1 });
  await routeBudget.recordNetworkCall("github.clone");
  await assert.rejects(() => routeBudget.recordNetworkCall("github.clone"), /repository clone budget/i);
});

test("rejects provider and model reservations beyond their ceilings", () => {
  const budget = new MemoryRunBudget({ modelUsd: 1, providerUsd: 1, externalNetworkCalls: 10, repositoryClones: 3, socialProfiles: 1 });
  assert.throws(() => budget.reserveModel(1.01), /model budget/i);
  assert.throws(() => budget.recordProvider(1.01), /provider budget/i);
});
