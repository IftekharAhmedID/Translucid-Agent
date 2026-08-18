import assert from "node:assert/strict";
import test from "node:test";

import { createHeadlessFixtureCompletion } from "./fixture-model.ts";

test("fixture model exercises research, synthesis revision, and commit in one lead", async () => {
  const complete = createHeadlessFixtureCompletion();
  const lead = await complete({ messages: [{ role: "user", content: "Begin the headless investigation." }] }, "lead-researcher");
  assert.equal(lead.toolCall?.name, "web.fetch");
  assert.equal((await complete({}, "lead-researcher")).toolCall?.name, "investigation.plan.set");
  assert.equal((await complete({}, "lead-researcher")).toolCall?.name, "investigation.synthesis.begin");
  assert.equal((await complete({}, "lead-researcher")).toolCall?.name, "investigation.finding.upsert");
  assert.equal((await complete({}, "lead-researcher")).toolCall?.name, "web.fetch");
  assert.equal((await complete({}, "lead-researcher")).toolCall?.name, "investigation.finding.upsert");
  assert.equal((await complete({}, "lead-researcher")).toolCall?.name, "investigation.finding.upsert");
  assert.equal((await complete({}, "lead-researcher")).toolCall?.name, "investigation.summary.set");
  assert.equal((await complete({}, "lead-researcher")).toolCall?.name, "investigation.commit");
});
