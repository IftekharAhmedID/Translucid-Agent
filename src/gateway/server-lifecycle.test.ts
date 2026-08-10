import assert from "node:assert/strict";
import test from "node:test";

import { canWriteGatewayError } from "./server.ts";

test("gateway writes JSON errors only before an HTTP response starts", () => {
  assert.equal(canWriteGatewayError({ headersSent: false, writableEnded: false, destroyed: false }), true);
  assert.equal(canWriteGatewayError({ headersSent: true, writableEnded: false, destroyed: false }), false);
  assert.equal(canWriteGatewayError({ headersSent: false, writableEnded: true, destroyed: false }), false);
  assert.equal(canWriteGatewayError({ headersSent: false, writableEnded: false, destroyed: true }), false);
});
