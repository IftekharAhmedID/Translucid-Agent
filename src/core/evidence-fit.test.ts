import assert from "node:assert/strict";
import test from "node:test";

import { evidenceQuoteHasClaimAnchor } from "./evidence-fit.ts";

test("evidence quote must share a meaningful claim anchor", () => {
  assert.equal(evidenceQuoteHasClaimAnchor("I work as Principal Software Engineer at Arm.", "Diego Russo is a Principal Software Engineer at Arm."), true);
  assert.equal(evidenceQuoteHasClaimAnchor("The weather forecast is sunny tomorrow.", "Diego Russo is a Principal Software Engineer at Arm."), false);
});
