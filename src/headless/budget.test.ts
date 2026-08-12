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
  await budget.reserveModel(1.25);
  await budget.recordProvider(2.5);

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

test("rejects provider and model reservations beyond their ceilings", async () => {
  const budget = new MemoryRunBudget({ modelUsd: 1, providerUsd: 1, externalNetworkCalls: 10, repositoryClones: 3, socialProfiles: 1 });
  await assert.rejects(() => budget.reserveModel(1.01), /model budget/i);
  await assert.rejects(() => budget.recordProvider(1.01), /provider budget/i);
});

test("restores cumulative usage and persists every successful reservation", async () => {
  const persisted = [] as Array<ReturnType<MemoryRunBudget["snapshot"]>>;
  const budget = new MemoryRunBudget(
    { modelUsd: 5, providerUsd: 10, externalNetworkCalls: 5, repositoryClones: 3, socialProfiles: 1 },
    {
      initial: { modelUsd: 1, providerUsd: 2, externalNetworkCalls: 1, routeCounts: { "web.fetch": 1 } },
      onChange: (snapshot) => { persisted.push(structuredClone(snapshot)); },
    },
  );

  await budget.reserveModel(0.5);
  await budget.recordProvider(1);
  await budget.recordNetworkCall("github.rest");
  await budget.flush();

  assert.deepEqual(budget.snapshot(), {
    modelUsd: 1.5,
    providerUsd: 3,
    externalNetworkCalls: 2,
    routeCounts: { "github.rest": 1, "web.fetch": 1 },
  });
  assert.equal(persisted.length, 3);
  assert.deepEqual(persisted.at(-1), budget.snapshot());
});

test("rolls back an in-memory reservation when atomic persistence fails", async () => {
  let persistenceAttempts = 0;
  const budget = new MemoryRunBudget(
    { modelUsd: 5, providerUsd: 10, externalNetworkCalls: 5, repositoryClones: 3, socialProfiles: 1 },
    {
      onChange: () => {
        persistenceAttempts += 1;
        throw new Error("disk unavailable");
      },
    },
  );

  await assert.rejects(() => budget.reserveModel(0.5), /disk unavailable/i);
  assert.equal(persistenceAttempts, 1);
  assert.deepEqual(budget.snapshot(), {
    modelUsd: 0,
    providerUsd: 0,
    externalNetworkCalls: 0,
    routeCounts: {},
  });
});
