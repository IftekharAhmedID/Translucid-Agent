import assert from "node:assert/strict";
import test from "node:test";

import { latestUsableAssistantText } from "./controller.ts";

test("falls back past an aborted assistant message to durable public text", () => {
  const messages = [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "Durable specialist coverage is available." }] },
    { info: { role: "assistant", error: { name: "MessageAbortedError" } }, parts: [{ type: "reasoning", text: "unfinished private draft" }] },
  ];

  assert.equal(latestUsableAssistantText(messages), "Durable specialist coverage is available.");
});
