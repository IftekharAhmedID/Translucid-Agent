import assert from "node:assert/strict";
import test from "node:test";

import { createHeadlessFixtureCompletion } from "./fixture-model.ts";

test("fixture model exercises research delegation and specialist capture", async () => {
  const complete = createHeadlessFixtureCompletion();
  const lead = await complete({ messages: [{ role: "user", content: "Begin the headless investigation." }] }, "lead-researcher");
  assert.equal(lead.toolCall?.name, "task");
  const specialist = await complete({}, "professional-researcher");
  assert.equal(specialist.toolCall?.name, "web.fetch");
  const memo = await complete({}, "professional-researcher");
  assert.match(memo.content ?? "", /\[S1\]/);
});

test("fixture model publishes through the five native report tools", async () => {
  const complete = createHeadlessFixtureCompletion();
  const body = { messages: [{ role: "user", content: "Research is complete. Publish the investigation." }], tools: [{ type: "function", function: { name: "report.progress.get" } }] };
  assert.equal((await complete(body, "lead-researcher")).toolCall?.name, "report.progress.get");
  assert.equal((await complete(body, "lead-researcher")).toolCall?.name, "report.summary.set");
  assert.equal((await complete(body, "lead-researcher")).toolCall?.name, "report.finding.upsert");
  assert.equal((await complete(body, "lead-researcher")).toolCall?.name, "report.progress.get");
  assert.equal((await complete(body, "lead-researcher")).toolCall?.name, "report.finalize");
});
