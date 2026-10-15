import test from "node:test";
import assert from "node:assert/strict";
import { createDispatcher } from "./dispatch.ts";

const origin = "https://tracedog.co";
const payload = { kind: "text", text: "word ".repeat(15), email: "person@company.org" };
const post = (body: unknown, requestOrigin = origin) => new Request("https://example.supabase.co/functions/v1/start-investigation", { method: "POST", headers: { Origin: requestOrigin, "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("public dispatcher validates origin, personal email, text limits before launching", async () => {
  let launches = 0;
  const handle = createDispatcher({ origin, enabled: true, launch: async () => { launches++; } });
  const badOrigin = await handle(post(payload, "https://evil.example"));
  assert.equal(badOrigin.status, 403); assert.equal(badOrigin.headers.get("Access-Control-Allow-Origin"), null);
  for (const body of [{ ...payload, email: "a@gmail.com" }, { ...payload, email: "a@yahoo.com" }, { ...payload, text: "word ".repeat(14) }, { ...payload, text: "word ".repeat(1501) }, { ...payload, website: "spam.example" }]) assert.equal((await handle(post(body))).status, 400);
  assert.equal(launches, 0);
  const accepted = await handle(post(payload));
  assert.equal(accepted.status, 202); assert.ok((await accepted.json()).submissionId);
  assert.equal(accepted.headers.get("Access-Control-Allow-Origin"), origin); assert.equal(launches, 1);
});

test("dispatcher limits request bytes, strips unrelated fields and hides infrastructure errors", async () => {
  let submitted: unknown;
  const handle = createDispatcher({ origin, enabled: true, launch: async value => { submitted = value; } });
  assert.equal((await handle(post({ ...payload, padding: "x".repeat(3 * 1024 * 1024) }))).status, 413);
  await handle(post({ ...payload, arbitrarySecret: "not-forwarded" }));
  assert.deepEqual(submitted, { kind: "text", text: payload.text.trim(), email: payload.email });
  const broken = createDispatcher({ origin, enabled: true, launch: async () => { throw new Error("private-provider-detail"); } });
  const response = await broken(post(payload)); assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /private-provider-detail/);
  const disabled = createDispatcher({ origin, enabled: false, launch: async () => {} });
  assert.equal((await disabled(post(payload))).status, 503);
});
