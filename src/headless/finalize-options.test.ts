import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseFinalizeArguments } from "./finalize-options.ts";

test("requires an absolute run directory and accepts keep-debug and local watch", () => {
  assert.deepEqual(parseFinalizeArguments(["--run", "/tmp/runs/run-one", "--keep-debug", "--watch"]), {
    runDirectory: "/tmp/runs/run-one",
    keepDebug: true,
    watch: true,
  });
  assert.throws(() => parseFinalizeArguments(["--run", "runs/run-one"]), /absolute/i);
  assert.throws(() => parseFinalizeArguments([]), /--run/i);
});

test("publishing-only recovery cannot construct or invoke a research provider adapter", async () => {
  const source = await readFile(new URL("./finalize-cli.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /ProviderExecutor|createFileProviderBackend|executor:/);
  assert.match(source, /allowedTools: new Set\(\["source\.excerpts", "source\.index", \.\.\.reportToolNames\]\)/);
  assert.match(source, /runPublishingRecovery/);
  assert.match(source, /reportStore\.markPublished/);
});
