import assert from "node:assert/strict";
import test from "node:test";

import { providerDeadlineMs, providerTimeoutMs } from "./provider-policy.ts";

test("provider routes have explicit deadlines including sixty seconds for Bright Data", () => {
  assert.equal(providerTimeoutMs("exa.search"), 20_000);
  assert.equal(providerTimeoutMs("exa.search.deep"), 30_000);
  assert.equal(providerTimeoutMs("exa.search.deep-reasoning"), 60_000);
  assert.equal(providerTimeoutMs("linkdapi.profile"), 30_000);
  assert.equal(providerTimeoutMs("brightdata.linkedin-profile"), 60_000);
  assert.equal(providerTimeoutMs("github.rest"), 20_000);
});

test("provider deadlines clamp to remaining case time", () => {
  const now = Date.parse("2026-08-09T12:00:00.000Z");
  assert.equal(providerDeadlineMs("brightdata.linkedin-profile", now + 35_000, now), 35_000);
  assert.equal(providerDeadlineMs("brightdata.linkedin-profile", now + 90_000, now), 60_000);
  assert.equal(providerDeadlineMs("exa.search", now - 1, now), 1);
});
