import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("finalization verifies the temporary PDF and publishes result.json last", async () => {
  const source = await readFile(join(process.cwd(), "src", "headless", "finalize-cli.ts"), "utf8");
  const steps = [
    "atomicWrite(reportTemporaryPath",
    "verifyInvestigationReport(await readFile(reportTemporaryPath))",
    "publishFinalizationProvenance(workspace.root)",
    "rename(reportTemporaryPath, reportPath)",
    "atomicWrite(resultPath",
  ].map((text) => source.indexOf(text));
  assert.equal(steps.every((index) => index >= 0), true);
  assert.deepEqual(steps, [...steps].sort((left, right) => left - right));
  assert.doesNotMatch(source, /fallback.*(?:v3|v4)/iu);
});
