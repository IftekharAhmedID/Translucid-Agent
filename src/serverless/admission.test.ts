import test from "node:test";
import assert from "node:assert/strict";
import { checkDailyCapacity } from "./admission.ts";

test("daily admission counts recent TraceDog deliveries and active jobs without a database", async () => {
  const now = Date.parse("2026-10-15T04:00:00Z");
  const email = { id: "one", from: "TraceDog <reports@example.org>", subject: "Your TraceDog PDF investigation report", created_at: "2026-10-15 03:00:00.000000+00" };
  const envs = { RESEND_API_KEY: "private", RESEND_FROM: email.from };
  const response = (data: unknown[], has_more = false) => async () => Response.json({ data, has_more });
  await checkDailyCapacity(envs, 1, response([email, { ...email, created_at: "2026-10-13T04:00:00Z" }]), now);
  await assert.rejects(checkDailyCapacity(envs, 1, response(Array(9).fill(email)), now), /daily capacity/);
  await checkDailyCapacity(envs, 1, response(Array(20).fill({ ...email, from: "other@example.org" })), now);
  await assert.rejects(checkDailyCapacity(envs, 0, async () => new Response(null, { status: 503 }), now), /capacity check/);
  await assert.rejects(checkDailyCapacity(envs, 0, response([], true), now), /capacity check/);
});
