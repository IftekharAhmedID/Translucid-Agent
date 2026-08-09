import assert from "node:assert/strict";
import test from "node:test";

import { assertPublicHttpUrl, redactSecrets } from "./http.ts";

test("public fetch rejects loopback, credentials, and non-http protocols", async () => {
  await assert.rejects(() => assertPublicHttpUrl("http://127.0.0.1/private"));
  await assert.rejects(() => assertPublicHttpUrl("http://[::1]/private"));
  await assert.rejects(() => assertPublicHttpUrl("https://user:pass@example.com"));
  await assert.rejects(() => assertPublicHttpUrl("file:///etc/passwd"));
});

test("secret redaction removes credential-shaped object fields", () => {
  assert.deepEqual(
    redactSecrets({ token: "secret", nested: { authorization: "Bearer secret", useful: "kept" } }),
    { token: "[REDACTED]", nested: { authorization: "[REDACTED]", useful: "kept" } },
  );
  assert.equal(redactSecrets("https://example.test/path?token=secret&query=kept"), "https://example.test/path?token=%5BREDACTED%5D&query=kept");
  assert.equal(redactSecrets("Bearer secret-value"), "Bearer [REDACTED]");
});
