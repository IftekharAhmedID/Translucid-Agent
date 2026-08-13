import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("finalization-only recovery cannot construct or invoke a research provider adapter", async () => {
  const source = await readFile(new URL("./finalize-cli.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /ProviderExecutor|createFileProviderBackend|executor:/);
  assert.match(source, /allowedTools: new Set\(\)/);
  assert.doesNotMatch(source, /source\.excerpts/);
  assert.match(source, /runFinalizationPipeline/);
});
