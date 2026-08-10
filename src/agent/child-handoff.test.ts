import assert from "node:assert/strict";
import test from "node:test";

import { childTaskEnvelope, needsChildHandoffContinuation, publicAssistantText } from "../../runtime/opencode/plugin/child-handoff.ts";

test("empty native task results receive one completion continuation", () => {
  assert.equal(needsChildHandoffContinuation('<task id="child" state="completed">\n<task_result>\n\n</task_result>\n</task>'), true);
  assert.equal(needsChildHandoffContinuation('<task id="child" state="completed">\n<task_result>done</task_result>\n</task>'), false);
});

test("child handoffs include only public text parts", () => {
  assert.equal(publicAssistantText([
    { type: "reasoning", text: "private" },
    { type: "text", text: "  public result  " },
    { type: "tool", text: "tool output" },
  ]), "public result");
  assert.match(childTaskEnvelope("child", "done"), /<task_result>\ndone\n<\/task_result>/);
});
