import assert from "node:assert/strict";
import test from "node:test";

import { investigationDraftSchema } from "./result-contract.ts";
import { createHeadlessFixtureCompletion } from "./fixture-model.ts";

test("fixture model exercises delegation, provider capture, compilation, and audit", async () => {
  const complete = createHeadlessFixtureCompletion();
  const lead = await complete({}, "lead-researcher");
  assert.equal(lead.toolCall?.name, "task");
  assert.match(String(lead.toolCall?.arguments.prompt), /WAVE: INITIAL/);

  const specialist = await complete({}, "professional-researcher");
  assert.equal(specialist.toolCall?.name, "web.fetch");
  const memo = await complete({}, "professional-researcher");
  assert.match(memo.content ?? "", /\[S1\]/);

  const compiler = await complete({}, "evidence-compiler");
  const draft = investigationDraftSchema.parse(JSON.parse(compiler.content ?? ""));
  assert.equal(draft.claims[0]?.facets.length, 3);
  assert.equal(draft.evidence[0]?.sourceRef, "S1");

  const audit = await complete({}, "evidence-auditor");
  assert.deepEqual(JSON.parse(audit.content ?? ""), { status: "PASSED", defects: [] });
});
