import assert from "node:assert/strict";
import test from "node:test";

import { compactToolResultForAgent } from "./agent-tool-result.ts";

test("agent-facing provider results keep artifact IDs and useful excerpts below the OpenCode output limit", () => {
  const result = compactToolResultForAgent({
    status: "OK",
    capability: "WEB_SEARCH",
    provider: "exa",
    data: {
      results: [{
        text: "navigation ".repeat(100_000),
        highlights: ["Diego Russo organised the CPython Core Dev Sprint 2025 at Arm Cambridge."],
      }],
    },
    artifactIds: ["11111111-1111-4111-8111-111111111111"],
    evidenceEligibleArtifactIds: ["11111111-1111-4111-8111-111111111111"],
    observedAt: "2026-08-10T00:00:00.000Z",
    costUsd: 0.001,
    costSource: "REPORTED",
  });

  const serialized = JSON.stringify(result);
  assert.ok(Buffer.byteLength(serialized) <= 24 * 1024);
  assert.match(serialized, /11111111-1111-4111-8111-111111111111/);
  assert.match(serialized, /CPython Core Dev Sprint 2025/);
  assert.equal(result.dataTruncated, true);
  assert.match(result.instruction ?? "", /never refetch/i);
});

test("agent-facing provider results redact secret-shaped response fields", () => {
  const result = compactToolResultForAgent({
    status: "OK",
    capability: "LINKEDIN_PROFILE",
    provider: "linkdapi",
    data: { name: "Diego Russo", access_token: "should-not-cross-the-gateway" },
    artifactIds: ["22222222-2222-4222-8222-222222222222"],
    evidenceEligibleArtifactIds: ["22222222-2222-4222-8222-222222222222"],
    observedAt: "2026-08-10T00:00:00.000Z",
    costUsd: 0,
    costSource: "UNKNOWN",
  });

  assert.doesNotMatch(JSON.stringify(result), /should-not-cross-the-gateway/);
  assert.match(JSON.stringify(result), /\[REDACTED\]/);
});
