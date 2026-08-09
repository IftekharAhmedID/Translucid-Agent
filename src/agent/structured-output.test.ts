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

test("rejects missing or malformed structured output", () => {
  assert.throws(
    () => extractStructuredOutput({ info: { role: "assistant" }, parts: [{ type: "text", text: "not json" }] }),
    /valid structured output/i,
  );
});
