import assert from "node:assert/strict";
import test from "node:test";

import { extractMarkedJson } from "../agent/structured-output.ts";
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

  const structuredBody = { tools: [{ type: "function", function: { name: "StructuredOutput" } }] };
  const dossier = await complete({ messages: [{ role: "user", content: "MODE: EVIDENCE_DOSSIER" }] }, "evidence-compiler");
  assert.match(dossier.content ?? "", /^TL_CLAIM /m);
  assert.match(dossier.content ?? "", /^TL_COVERAGE /m);

  const compiler = await complete(structuredBody, "evidence-compiler");
  assert.equal(compiler.toolCall?.name, "StructuredOutput");
  const draft = investigationDraftSchema.parse(compiler.toolCall?.arguments);
  assert.equal(draft.claims[0]?.facets.length, 3);
  assert.equal(draft.evidence[0]?.sourceRef, "S1");

  const audit = await complete(structuredBody, "evidence-auditor");
  assert.deepEqual(audit, { toolCall: { name: "StructuredOutput", arguments: { status: "PASSED", defects: [] } } });

  const jsonCompiler = await complete({}, "evidence-compiler");
  investigationDraftSchema.parse(extractMarkedJson({ info: { role: "assistant" }, parts: [{ type: "text", text: jsonCompiler.content ?? "" }] }));
  const jsonAudit = await complete({}, "evidence-auditor");
  assert.deepEqual(extractMarkedJson({ info: { role: "assistant" }, parts: [{ type: "text", text: jsonAudit.content ?? "" }] }), { status: "PASSED", defects: [] });
});

test("fixture payload parsing ignores the GO transport schema suffix", async () => {
  const complete = createHeadlessFixtureCompletion();
  const body = {
    messages: [{
      role: "user",
      content: [{
        type: "text",
        text: `MODE: COVERAGE_ONLY\n\n${JSON.stringify({ input: { pages: [{ page: 1, lines: [{ line: 1, text: "Casey Morgan" }] }] }, repairDefects: [] })}\n\nReturn exactly one JSON object inside these markers:\n<RESULT_JSON>\n{}\n</RESULT_JSON>\nThe object must validate against this JSON Schema:\n${JSON.stringify({ type: "object" })}`,
      }],
    }],
    tools: [{ type: "function", function: { name: "StructuredOutput" } }],
  };
  const response = await complete(body, "evidence-compiler");
  const claims = response.toolCall?.arguments && typeof response.toolCall.arguments === "object"
    ? (response.toolCall.arguments as { claims?: Array<{ sourceSpan?: { text?: string } }> }).claims
    : undefined;
  assert.equal(claims?.[0]?.sourceSpan?.text, "Casey Morgan");
});
