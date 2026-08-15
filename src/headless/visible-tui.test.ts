import assert from "node:assert/strict";
import test from "node:test";

import { buildVisibleTuiCommand } from "./visible-tui.ts";

test("visible TUI command keeps the run URL, session, and password shell-safe", () => {
  const command = buildVisibleTuiCommand({
    kind: "LOCAL",
    id: "container-1",
    openCodeUrl: "http://127.0.0.1:1234?token=a'b",
    manifestHash: "a".repeat(64),
  }, "secret'a", "ses_123");
  assert.match(command, /OPENCODE_SERVER_PASSWORD=/);
  assert.match(command, /attach/);
  assert.match(command, /ses_123/);
  assert.match(command, /'\\''/);
});
