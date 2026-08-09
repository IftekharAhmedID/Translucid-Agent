import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "./config.ts";

test("configuration defaults to the safe synthetic fixture runtime", () => {
  const config = loadConfig({
    DATABASE_URL: "postgres://example.test/translucid",
  });

  assert.equal(config.dataClassification, "SYNTHETIC");
  assert.equal(config.openCodeProvider, "ZEN");
  assert.equal(config.openCodeUpstreamUrl, "https://opencode.ai/zen/v1/chat/completions");
  assert.equal(config.providerMode, "fixture");
  assert.equal(config.runtimeDefault, "LOCAL");
  assert.equal(config.pdlLiveEnabled, false);
  assert.equal(config.runnerConcurrency, 4);
});

test("configuration accepts the explicit public-professional boundary", () => {
  const config = loadConfig({
    DATABASE_URL: "postgres://example.test/translucid",
    DATA_CLASSIFICATION: "PUBLIC_PROFESSIONAL",
    OPENCODE_PROVIDER: "GO",
  });

  assert.equal(config.dataClassification, "PUBLIC_PROFESSIONAL");
  assert.equal(config.openCodeProvider, "GO");
  assert.equal(config.openCodeUpstreamUrl, "https://opencode.ai/zen/go/v1/chat/completions");
});

test("configuration rejects unapproved data classifications", () => {
  assert.throws(
    () =>
      loadConfig({
        DATABASE_URL: "postgres://example.test/translucid",
        DATA_CLASSIFICATION: "PERSONAL",
      }),
    /DATA_CLASSIFICATION/i,
  );
});

test("E2B runtime requires an HTTPS gateway URL", () => {
  assert.throws(
    () =>
      loadConfig({
        DATABASE_URL: "postgres://example.test/translucid",
        RUNTIME_DEFAULT: "E2B",
        E2B_API_KEY: "redacted-test-value",
        E2B_TEMPLATE_ID: "template-test",
        E2B_GATEWAY_PUBLIC_URL: "http://localhost:3001",
      }),
    /HTTPS/i,
  );
});

test("PDL live execution cannot be enabled", () => {
  assert.throws(
    () =>
      loadConfig({
        DATABASE_URL: "postgres://example.test/translucid",
        PDL_LIVE_ENABLED: "true",
      }),
    /PDL live execution is disabled by policy/i,
  );
});
