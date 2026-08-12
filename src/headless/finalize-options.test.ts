import assert from "node:assert/strict";
import test from "node:test";

import { parseFinalizeArguments } from "./finalize-options.ts";

test("requires an absolute run directory and accepts keep-debug", () => {
  assert.deepEqual(parseFinalizeArguments(["--run", "/tmp/runs/run-one", "--keep-debug"]), {
    runDirectory: "/tmp/runs/run-one",
    keepDebug: true,
  });
  assert.throws(() => parseFinalizeArguments(["--run", "runs/run-one"]), /absolute/i);
  assert.throws(() => parseFinalizeArguments([]), /--run/i);
  assert.throws(() => parseFinalizeArguments(["--run", "/tmp/run", "--watch"]), /unknown argument/i);
});
