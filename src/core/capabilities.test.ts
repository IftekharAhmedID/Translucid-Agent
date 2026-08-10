import assert from "node:assert/strict";
import test from "node:test";

import { buildCapabilityRegistry } from "./capabilities.ts";

test("fixture mode exposes every implemented route without real credentials", () => {
  const registry = buildCapabilityRegistry({ PROVIDER_MODE: "fixture" });

  assert.equal(registry.WEB_SEARCH.state, "READY_FIXTURE");
  assert.equal(registry.PATENTS.state, "READY_FIXTURE");
  assert.equal(registry.PROFESSIONAL_HISTORY.state, "READY_FIXTURE");
});

test("live PDL is disabled by policy even when a key is present", () => {
  const registry = buildCapabilityRegistry({
    PROVIDER_MODE: "live",
    PDL_API_KEY: "redacted-test-value",
    PDL_LIVE_ENABLED: "true",
  });

  assert.equal(registry.PROFESSIONAL_HISTORY.state, "DISABLED_POLICY");
});

test("live capability readiness is scoped to exact credentials and datasets", () => {
  const registry = buildCapabilityRegistry({
    PROVIDER_MODE: "live",
    EXA_API_KEY: "redacted-test-value",
    BRIGHTDATA_API_KEY: "redacted-test-value",
    BRIGHTDATA_LINKEDIN_PROFILE_DATASET_ID: "fixture-dataset",
    PUBLIC_API_CONTACT_EMAIL: "engineering@example.test",
  });

  assert.equal(registry.WEB_SEARCH.state, "READY");
  assert.equal(registry.LINKEDIN_PROFILE.state, "READY");
  assert.equal(registry.SOCIAL_PROFILE.state, "DISABLED_MISSING_CONFIG");
  assert.equal(registry.PATENTS.state, "DISABLED_MISSING_CONFIG");
  assert.equal(registry.SCHOLARLY.state, "DEGRADED");
});

test("authenticated GitHub is ready without coupling it to public API contact configuration", () => {
  const registry = buildCapabilityRegistry({
    PROVIDER_MODE: "live",
    GITHUB_TOKEN: "redacted-test-value",
    USPTO_API_KEY: "redacted-test-value",
  });

  assert.equal(registry.GITHUB.state, "READY");
  assert.equal(registry.ARCHIVES.state, "DISABLED_MISSING_CONFIG");
  assert.equal(registry.PATENTS.state, "DISABLED_MISSING_CONFIG");
  assert.equal(registry.PACKAGES.state, "DISABLED_MISSING_CONFIG");
});
