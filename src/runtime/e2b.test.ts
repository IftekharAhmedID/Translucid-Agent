import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("E2B is secure, gateway-only, private, and killed on timeout", async () => {
  const source = await readFile(new URL("./e2b.ts", import.meta.url), "utf8");
  assert.match(source, /secure: true/);
  assert.match(source, /allowOut: \[gatewayHost\]/);
  assert.match(source, /denyOut: \[ALL_TRAFFIC\]/);
  assert.match(source, /allowPublicTraffic: false/);
  assert.match(source, /onTimeout: "kill"/);
  assert.match(source, /if \(!trafficAccessToken\) throw/);
  assert.match(source, /accepted unauthenticated traffic/);
  assert.match(source, /manifest\.manifestHash !== input\.expectedManifestHash/);
});
