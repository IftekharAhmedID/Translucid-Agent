import assert from "node:assert/strict";
import test from "node:test";

import { providerCostCompleteness } from "./cost-completeness.ts";

test("provider cost completeness distinguishes strict, partial and unknown telemetry", () => {
  assert.equal(providerCostCompleteness([]), "UNKNOWN");
  assert.equal(providerCostCompleteness([{ costSource: "UNKNOWN" }]), "UNKNOWN");
  assert.equal(providerCostCompleteness([{ costSource: "FREE_PUBLIC" }, { costSource: "REPORTED" }]), "STRICT");
  assert.equal(providerCostCompleteness([{ costSource: "CONFIGURED" }, { costSource: "UNKNOWN" }]), "PARTIAL");
});
