import assert from "node:assert/strict";
import test from "node:test";

import { fetchWithRetry, retryDelayMilliseconds } from "./retry.ts";

test("Retry-After seconds override exponential backoff within the safety cap", () => {
  assert.equal(retryDelayMilliseconds("3", 0, 0), 3_000);
  assert.equal(retryDelayMilliseconds("30", 0, 0), 5_000);
});

test("missing or invalid Retry-After uses bounded exponential backoff", () => {
  assert.equal(retryDelayMilliseconds(null, 0, 0), 250);
  assert.equal(retryDelayMilliseconds("invalid", 2, 0), 1_000);
});

test("Retry-After HTTP dates are interpreted relative to the supplied clock", () => {
  assert.equal(retryDelayMilliseconds(new Date(4_000).toUTCString(), 0, 1_000), 3_000);
});

test("fetch retries a rate-limited response and returns the next result", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response("rate limited", { status: 429, headers: { "retry-after": "0" } })
      : Response.json({ ok: true });
  };
  try {
    const response = await fetchWithRetry("https://example.test", {}, 2);
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
