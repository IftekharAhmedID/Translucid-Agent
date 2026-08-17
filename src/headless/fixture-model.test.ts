import assert from "node:assert/strict";
import test from "node:test";

import { createHeadlessFixtureCompletion } from "./fixture-model.ts";

test("fixture model researches directly and captures one source", async () => {
  const complete = createHeadlessFixtureCompletion();
  const lead = await complete({ messages: [{ role: "user", content: "Begin the headless investigation." }] }, "lead-researcher");
  assert.equal(lead.toolCall?.name, "web.fetch");
  assert.equal((await complete({}, "lead-researcher")).toolCall?.name, "research.state.set");
  const research = await complete({}, "lead-researcher");
  assert.match(research.content ?? "", /\[S1\]/);
});

test("fixture report writer returns a complete structured finding batch and summary", async () => {
  const complete = createHeadlessFixtureCompletion();
  const finding = await complete({ messages: [{ role: "user", content: "Publication batch 1 of 1" }] }, "report-writer");
  const summary = await complete({ messages: [{ role: "user", content: "Publication summary" }] }, "report-writer");
  assert.match(finding.content ?? "", /"findings"/);
  assert.match(summary.content ?? "", /"summary"/);
});
