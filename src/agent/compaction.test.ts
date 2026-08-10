import assert from "node:assert/strict";
import test from "node:test";

import { serializeCompactionPayload } from "./compaction.ts";

test("compaction stays below 32 KiB while retaining required durable IDs and dead ends", () => {
  const payload = {
    rootEntityId: "root-person",
    resolvedIdentifiers: Array.from({ length: 80 }, (_, index) => ({ id: `identifier-${index}`, value: "x".repeat(1_000) })),
    entityLinks: Array.from({ length: 50 }, (_, index) => ({ id: `link-${index}`, evidenceIds: [`evidence-${index}`] })),
    rejectedIdentityAttempts: Array.from({ length: 30 }, (_, index) => ({ id: `reject-${index}` })),
    researchQuestions: [{ id: "question-active", claimIds: ["claim-1"], status: "IN_PROGRESS" }, { id: "question-dead", claimIds: ["claim-2"], status: "EXHAUSTED" }],
    attemptedProviderRoutes: Array.from({ length: 150 }, (_, index) => ({ providerRoute: "exa.search", requestFingerprint: `fingerprint-${index}` })),
    knownDeadEnds: [{ id: "question-dead", claimIds: ["claim-2"] }],
    strongestEvidence: [{ id: "evidence-strong", relation: "SUPPORTS" }],
    deadlineAt: "2026-08-09T20:00:00.000Z",
    budgetCounters: { "web.search": 12 },
  };
  const serialized = serializeCompactionPayload(payload);
  assert.ok(Buffer.byteLength(serialized) <= 32 * 1024);
  assert.match(serialized, /root-person/);
  assert.match(serialized, /question-active/);
  assert.match(serialized, /question-dead/);
  assert.match(serialized, /evidence-strong/);
});
