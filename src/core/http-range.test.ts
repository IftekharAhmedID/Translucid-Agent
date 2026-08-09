import assert from "node:assert/strict";
import test from "node:test";

import { parseByteRange } from "./http-range.ts";

test("byte ranges support bounded, open, and suffix requests", () => {
  assert.deepEqual(parseByteRange("bytes=2-5", 10), { start: 2, end: 5 });
  assert.deepEqual(parseByteRange("bytes=7-", 10), { start: 7, end: 9 });
  assert.deepEqual(parseByteRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.equal(parseByteRange("bytes=20-30", 10), undefined);
  assert.equal(parseByteRange("items=1-2", 10), undefined);
});
