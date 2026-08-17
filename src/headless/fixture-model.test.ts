import assert from "node:assert/strict";
import test from "node:test";

import { createHeadlessFixtureCompletion } from "./fixture-model.ts";

test("fixture model researches directly and captures one source", async () => {
  const complete = createHeadlessFixtureCompletion();
  const lead = await complete({ messages: [{ role: "user", content: "Begin the headless investigation." }] }, "lead-researcher");
  assert.equal(lead.toolCall?.name, "web.fetch");
  const research = await complete({}, "lead-researcher");
  assert.match(research.content ?? "", /\[S1\]/);
});

test("fixture model persists claim state before publishing", async () => {
  const complete = createHeadlessFixtureCompletion();
  const body = { messages: [{ role: "user", content: "Research is now frozen. Publish the investigation." }], tools: [{ type: "function", function: { name: "research.state.set" } }] };
  assert.equal((await complete(body, "lead-researcher")).toolCall?.name, "research.state.set");
  assert.equal((await complete(body, "lead-researcher")).toolCall?.name, "report.progress.get");
  assert.equal((await complete(body, "lead-researcher")).toolCall?.name, "report.summary.set");
  assert.equal((await complete(body, "lead-researcher")).toolCall?.name, "report.finding.upsert");
  assert.equal((await complete(body, "lead-researcher")).toolCall?.name, "report.progress.get");
  assert.equal((await complete(body, "lead-researcher")).toolCall?.name, "report.finalize");
});
