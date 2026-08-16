import assert from "node:assert/strict";
import test from "node:test";

import { orphanedLocalRuntimeNames } from "./reaper.ts";

test("local runtime reaper only selects Translucid containers without active runs", () => {
  assert.deepEqual(
    orphanedLocalRuntimeNames(["translucid-case-run-a", "translucid-case-run-b", "unrelated"], new Set(["run-a"])),
    ["translucid-case-run-b"],
  );
});
