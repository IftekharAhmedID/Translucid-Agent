import test from "node:test";
import assert from "node:assert/strict";
import { coordinatorEnvironment } from "./launch.ts";

test("E2B's reserved template variable cannot replace the intended investigator image", () => {
  const values = coordinatorEnvironment({ E2B_TEMPLATE_ID: "investigator-image", E2B_API_KEY: "server-key" });
  const sandboxEnvironment: Record<string, string> = { ...values, E2B_TEMPLATE_ID: "coordinator-image" };
  assert.equal(sandboxEnvironment.TRACEDOG_INVESTIGATOR_TEMPLATE_ID, "investigator-image");
  assert.equal(sandboxEnvironment.E2B_API_KEY, "server-key");
  assert.equal(values.E2B_TEMPLATE_ID, undefined);
  assert.throws(() => coordinatorEnvironment({}), /not configured/);
});
