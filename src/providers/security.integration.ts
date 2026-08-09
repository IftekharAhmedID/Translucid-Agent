import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { closeDatabase, getSql } from "../db/client.ts";
import { createInvestigation } from "../db/investigations.ts";
import { authorizeCaseToken, consumeBudget, issueCaseToken } from "./security.ts";

const databaseUrl = process.env.DATABASE_URL;

before(() => {
  if (!databaseUrl) return;
  process.env.PROVIDER_MODE = "fixture";
});

after(async () => {
  if (databaseUrl) await closeDatabase();
});

test("case tokens store only a digest and enforce run, tool, model, and expiry scope", { skip: !databaseUrl }, async () => {
  const created = await createInvestigation({
    submission: "Synthetic candidate",
    runtimeKind: "LOCAL",
    dataClassification: "SYNTHETIC",
  });
  const issued = await issueCaseToken({
    investigationId: created.investigationId,
    runId: created.runId,
    allowedTools: ["web.search"],
    allowedModels: ["opencode/deepseek-v4-flash"],
    ttlMs: 60_000,
  });

  const [stored] = await getSql()<Array<{ runtimeHandle: Record<string, unknown> }>>`
    SELECT runtime_handle AS "runtimeHandle" FROM runs WHERE id = ${created.runId}
  `;
  assert.ok(stored);
  assert.equal(JSON.stringify(stored.runtimeHandle).includes(issued.token), false);
  assert.equal(
    await authorizeCaseToken(issued.token, {
      kind: "tool",
      name: "web.search",
      investigationId: created.investigationId,
    }),
    created.runId,
  );
  await assert.rejects(() =>
    authorizeCaseToken(issued.token, {
      kind: "tool",
      name: "social.profile",
      investigationId: created.investigationId,
    }),
  );
});

test("budget consumption is atomic and rejects the first over-limit call", { skip: !databaseUrl }, async () => {
  const created = await createInvestigation({
    submission: "Synthetic budget case",
    runtimeKind: "LOCAL",
    dataClassification: "SYNTHETIC",
  });

  const results = await Promise.all(
    Array.from({ length: 16 }, () =>
      consumeBudget({
        runId: created.runId,
        counter: "web.search",
        increment: 1,
        ceiling: 15,
      }).then(() => true, () => false),
    ),
  );
  assert.equal(results.filter(Boolean).length, 15);
  assert.equal(results.filter((value) => !value).length, 1);
});
