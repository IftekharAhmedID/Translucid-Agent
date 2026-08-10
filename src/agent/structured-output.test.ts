import assert from "node:assert/strict";
import test from "node:test";

import { extractStructuredOutput } from "./structured-output.ts";

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
    /valid structured output/i,
  );
});
