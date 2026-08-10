import assert from "node:assert/strict";
import test from "node:test";

import { assertProviderModeAllowsClassification } from "./provider-boundary.ts";

test("public-professional investigations cannot run through synthetic fixture providers", () => {
  assert.throws(
    () => assertProviderModeAllowsClassification("PUBLIC_PROFESSIONAL", "fixture"),
    /public-professional.*live provider mode/i,
  );
});

test("synthetic fixture and public-professional live runs remain allowed", () => {
  assert.doesNotThrow(() => assertProviderModeAllowsClassification("SYNTHETIC", "fixture"));
  assert.doesNotThrow(() => assertProviderModeAllowsClassification("PUBLIC_PROFESSIONAL", "live"));
});
