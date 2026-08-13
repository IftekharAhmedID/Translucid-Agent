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

test("V5 summary input is limited to frozen claim and evidence records", async () => {
  const source = await readFile(join(process.cwd(), "src", "headless", "incremental-pipeline.ts"), "utf8");
  const summary = source.slice(source.indexOf("const compileSummary"), source.indexOf("const summaryConfiguration"));
  assert.doesNotMatch(summary, /input:\s*parsedInput/u);
});

test("V5 resumes an audit only when its dependency fingerprint matches", async () => {
  const source = await readFile(join(process.cwd(), "src", "headless", "incremental-pipeline.ts"), "utf8");
  assert.match(source, /manifest\.stages\.audit\?\.fingerprint === auditFingerprint[\s\S]*readJsonIfPresent\(join\(v5Root, "audit\.json"\)/u);
});

test("V5 persists bounded model attempts outside canonical stage records", async () => {
  const source = await readFile(join(process.cwd(), "src", "headless", "incremental-pipeline.ts"), "utf8");
  assert.match(source, /mkdir\(join\(v5Root, "attempts"\)/u);
  assert.match(source, /atomicJson\(attemptPath/u);
});
