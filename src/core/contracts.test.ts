import assert from "node:assert/strict";
import test from "node:test";

import { dataClassificationSchema } from "./contracts.ts";

test("data classification permits only synthetic or public professional evidence", () => {
  assert.equal(dataClassificationSchema.parse("SYNTHETIC"), "SYNTHETIC");
  assert.equal(dataClassificationSchema.parse("PUBLIC_PROFESSIONAL"), "PUBLIC_PROFESSIONAL");
  assert.throws(() => dataClassificationSchema.parse("PERSONAL"));
});
