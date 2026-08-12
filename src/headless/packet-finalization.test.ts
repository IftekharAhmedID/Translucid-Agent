import assert from "node:assert/strict";
import test from "node:test";

import { repairScope, type FinalizationDefect } from "./packet-finalization.ts";

function defect(overrides: Partial<FinalizationDefect>): FinalizationDefect {
  return {
    stage: "PACKET",
    code: "TEST",
    message: "test defect",
    claimKeys: [],
    evidenceKeys: [],
    repairable: true,
    ...overrides,
  };
}

test("repair scope permits exactly one repairable packet or summary", () => {
  assert.equal(repairScope([defect({ packetIndex: 2 })]), "PACKET");
  assert.equal(repairScope([defect({ stage: "SUMMARY", packetIndex: undefined })]), "SUMMARY");
  assert.equal(repairScope([defect({ stage: "COVERAGE", packetIndex: undefined })]), "COVERAGE");
});

test("repair scope fails closed for multiple packets, unscoped defects, or non-repairable defects", () => {
  assert.equal(repairScope([defect({ packetIndex: 0 }), defect({ packetIndex: 1 })]), undefined);
  assert.equal(repairScope([defect({ packetIndex: undefined })]), undefined);
  assert.equal(repairScope([defect({ stage: "AUDIT", repairable: false, packetIndex: undefined })]), undefined);
});
