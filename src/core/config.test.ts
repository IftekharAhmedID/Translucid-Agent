import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "./config.ts";

test("configuration defaults to the safe synthetic fixture runtime", () => {
  const config = loadConfig({
    DATABASE_URL: "postgres://example.test/translucid",
  });

  assert.equal(config.dataClassification, "SYNTHETIC");
  assert.equal(config.researchOpenCodeProvider, "GO");
  assert.equal(config.finalizerOpenCodeProvider, "GO");
  assert.equal(config.finalizerModel, "mimo-v2.5-pro");
  assert.equal(config.researchOpenCodeUpstreamUrl, "https://opencode.ai/zen/go/v1/chat/completions");
  assert.equal(config.finalizerOpenCodeUpstreamUrl, "https://opencode.ai/zen/go/v1/chat/completions");
  assert.equal(config.reasoningVariant, "medium");
  assert.equal(config.investigationTimeoutMs, 60 * 60_000);
  assert.equal(config.finalizationReserveMs, 12 * 60_000);
  assert.equal(config.toolCeilings["web.search"], 1_000);
  assert.equal(config.toolCeilings["web.fetch"], 2_000);
  assert.equal(config.providerMode, "fixture");
  assert.equal(config.runtimeDefault, "LOCAL");
  assert.equal(config.pdlLiveEnabled, false);
  assert.equal(config.runnerConcurrency, 4);
  assert.deepEqual(config.modelRequestTimeouts, {
    researchMs: 360_000,
    coverageMs: 480_000,
    packetMs: 600_000,
    summaryMs: 360_000,
    auditMs: 600_000,
    safetyReserveMs: 15_000,
  });
});

test("configuration allows stage-aware model request timeout overrides", () => {
  const config = loadConfig({
    DATABASE_URL: "postgres://example.test/translucid",
    MODEL_RESEARCH_TIMEOUT_MS: "420000",
    MODEL_COVERAGE_TIMEOUT_MS: "500000",
    MODEL_PACKET_TIMEOUT_MS: "610000",
    MODEL_SUMMARY_TIMEOUT_MS: "370000",
    MODEL_AUDIT_TIMEOUT_MS: "620000",
    MODEL_REQUEST_SAFETY_RESERVE_MS: "20000",
  });
  assert.deepEqual(config.modelRequestTimeouts, {
    researchMs: 420_000,
    coverageMs: 500_000,
    packetMs: 610_000,
    summaryMs: 370_000,
    auditMs: 620_000,
    safetyReserveMs: 20_000,
  });
});

test("configuration accepts the explicit public-professional boundary", () => {
  const config = loadConfig({
    DATABASE_URL: "postgres://example.test/translucid",
    DATA_CLASSIFICATION: "PUBLIC_PROFESSIONAL",
    RESEARCH_OPENCODE_PROVIDER: "ZEN",
    FINALIZER_OPENCODE_PROVIDER: "GO",
  });

  assert.equal(config.dataClassification, "PUBLIC_PROFESSIONAL");
  assert.equal(config.researchOpenCodeProvider, "ZEN");
  assert.equal(config.finalizerOpenCodeProvider, "GO");
  assert.equal(config.researchOpenCodeUpstreamUrl, "https://opencode.ai/zen/v1/chat/completions");
  assert.equal(config.finalizerOpenCodeUpstreamUrl, "https://opencode.ai/zen/go/v1/chat/completions");
});

test("legacy OPENCODE_PROVIDER remains a research-provider alias only", () => {
  const config = loadConfig({
    DATABASE_URL: "postgres://example.test/translucid",
    OPENCODE_PROVIDER: "ZEN",
  });

  assert.equal(config.researchOpenCodeProvider, "ZEN");
  assert.equal(config.finalizerOpenCodeProvider, "GO");
});

test("blank provider cost mappings remain unknown instead of configured zero", () => {
  const config = loadConfig({
    DATABASE_URL: "postgres://example.test/translucid",
    LINKDAPI_COST_USD_PER_CALL: "",
    BRIGHTDATA_COST_USD_PER_RECORD: "   ",
  });

  assert.equal(config.providerUnitCosts.LINKDAPI, undefined);
  assert.equal(config.providerUnitCosts.BRIGHTDATA, undefined);
});

test("the finalization reserve must fit inside the investigation deadline", () => {
  assert.throws(() => loadConfig({
    DATABASE_URL: "postgres://example.test/translucid",
    INVESTIGATION_TIMEOUT_MS: "600000",
    FINALIZATION_RESERVE_MS: "720000",
  }), /finalization reserve/i);
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
