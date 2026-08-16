import assert from "node:assert/strict";
import test from "node:test";

import { openCodeRuntimeEnvironment } from "./types.ts";

test("OpenCode keeps its disposable database outside the authoritative case directory", () => {
  assert.equal(openCodeRuntimeEnvironment.HOME, "/tmp/translucid-opencode");
  assert.equal(openCodeRuntimeEnvironment.XDG_CONFIG_HOME, "/tmp/translucid-opencode/.config");
  assert.doesNotMatch(JSON.stringify(openCodeRuntimeEnvironment), /\/workspace\/case/);
});
