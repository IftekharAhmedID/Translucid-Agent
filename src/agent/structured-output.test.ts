import assert from "node:assert/strict";
import test from "node:test";

import { extractMarkedJson, extractStructuredOutput, structuredOutputRecovery } from "./structured-output.ts";

test("extracts exactly one marked JSON result while ignoring surrounding prose", () => {
  assert.deepEqual(
    extractMarkedJson({
      info: { role: "assistant" },
      parts: [{ type: "text", text: "Done.\n<RESULT_JSON>\n{\"ok\":true}\n</RESULT_JSON>\nEnd." }],
    }),
    { ok: true },
  );
});

test("rejects missing, repeated, nested, and malformed marked JSON", () => {
  const message = (text: string) => ({ info: { role: "assistant" }, parts: [{ type: "text", text }] });
  assert.throws(() => extractMarkedJson(message("{\"ok\":true}")), /exactly one RESULT_JSON region/);
  assert.throws(() => extractMarkedJson(message("<RESULT_JSON>{}</RESULT_JSON><RESULT_JSON>{}</RESULT_JSON>")), /exactly one RESULT_JSON region/);
  assert.throws(() => extractMarkedJson(message("<RESULT_JSON>{\"value\":\"<RESULT_JSON>\"}</RESULT_JSON>")), /nested RESULT_JSON marker/);
  assert.throws(() => extractMarkedJson(message("<RESULT_JSON>{broken}</RESULT_JSON>")), /valid JSON/);
});

test("uses native OpenCode structured output when present", () => {
  assert.deepEqual(
    extractStructuredOutput({ info: { role: "assistant", structured: { ok: true } }, parts: [] }),
    { ok: true },
  );
});

test("parses a validated JSON text fallback for OpenAI-compatible fixture providers", () => {
  assert.deepEqual(
    extractStructuredOutput({
      info: { role: "assistant" },
      parts: [{ type: "text", text: "{\"ok\":true}" }],
    }),
    { ok: true },
  );
});

test("parses a JSON-only fenced fallback when a compatible provider adds markdown", () => {
  assert.deepEqual(
    extractStructuredOutput({
      info: { role: "assistant" },
      parts: [{ type: "text", text: "```json\n{\"ok\":true}\n```" }],
    }),
    { ok: true },
  );
});

test("extracts one balanced JSON object when a provider adds a short preface and suffix", () => {
  assert.deepEqual(
    extractStructuredOutput({
      info: { role: "assistant" },
      parts: [{ type: "text", text: "Audit complete.\n```json\n{\"ok\":true,\"note\":\"a } inside a string\"}\n```\nDone." }],
    }),
    { ok: true, note: "a } inside a string" },
  );
});

test("rejects missing or malformed structured output", () => {
  assert.throws(
    () => extractStructuredOutput({ info: { role: "assistant" }, parts: [{ type: "text", text: "not json" }] }),
    /valid structured output.*textCharacters=8/i,
  );
});

test("classifies reasoning-only responses without pretending JSON parsing failed", () => {
  assert.throws(
    () => extractStructuredOutput({ info: { role: "assistant" }, parts: [{ type: "reasoning" }] }),
    /NO_TEXT_OUTPUT/,
  );
});

test("surfaces OpenCode message errors before parsing any parts", () => {
  assert.throws(
    () => extractStructuredOutput({
      info: { role: "assistant", error: { name: "StructuredOutputError" } },
      parts: [{ type: "text", text: "{\"ok\":true}" }],
    }),
    /StructuredOutputError/,
  );
});

test("reasoning-only output continues the same session instead of repeating the audit", () => {
  assert.equal(structuredOutputRecovery(new Error("NO_TEXT_OUTPUT: reasoning only")), "SAME_SESSION_COMPLETION");
  assert.equal(structuredOutputRecovery(new Error("Session did not produce valid structured output")), "FRESH_SCHEMA_RETRY");
});
