import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

for (const file of ["cli.ts", "finalize-cli.ts"]) {
  test(`${file} verifies the temporary PDF and publishes result.json last`, async () => {
    const source = await readFile(join(process.cwd(), "src", "headless", file), "utf8");
    const steps = [
      "assertPublishableResult(",
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
}

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

test("V5 retrieval and canonicalization consume the frozen authority snapshot only", async () => {
  const [pipeline, sourceStore, resultContract] = await Promise.all([
    readFile(join(process.cwd(), "src", "headless", "incremental-pipeline.ts"), "utf8"),
    readFile(join(process.cwd(), "src", "headless", "source-store.ts"), "utf8"),
    readFile(join(process.cwd(), "src", "headless", "result-contract.ts"), "utf8"),
  ]);
  assert.match(pipeline, /sourceAuthoritySnapshotHash/u);
  assert.match(pipeline, /officialDomainRegistryHash/u);
  assert.match(resultContract, /authorityByRef/u);
  assert.doesNotMatch(`${pipeline}\n${sourceStore}\n${resultContract}`, /effectiveSourceAuthority\(/u);
  assert.ok(pipeline.indexOf("const { registry: officialDomainRegistry, snapshot: sourceAuthority } = await loadSourceAuthority") < pipeline.indexOf("await rm(v5Root, { recursive: true, force: true })"));
});

test("V5 reasoning-only recovery completes the same session without spending the repair", async () => {
  const source = await readFile(new URL("incremental-pipeline.ts", import.meta.url), "utf8");
  assert.match(source, /structuredOutputRecovery\(error\) !== "SAME_SESSION_COMPLETION"/u);
  assert.match(source, /sessionID: sessionId/u);
  assert.match(source, /completionContinuation/u);
  assert.match(source, /Do not repeat the analysis, revisit sources, or add prose/u);
});

test("V5 claim repair retains the bounded assigned-line window", async () => {
  const source = await readFile(new URL("incremental-pipeline.ts", import.meta.url), "utf8");
  assert.match(source, /const claimWindow = \{/u);
  assert.match(source, /\{ \.\.\.claimWindow, repair: finalizerRepairPayload\(originalResponse, validatorError\) \}/u);
});

test("V5 evidence retrieval fingerprints deduplicated candidate refs", async () => {
  const pipeline = await readFile(new URL("incremental-pipeline.ts", import.meta.url), "utf8");
  const store = await readFile(new URL("source-store.ts", import.meta.url), "utf8");
  assert.match(pipeline, /memo-first-bounded-v4-deduplicated/u);
  assert.match(store, /selectedRefs\.has\(excerpt\.ref\)/u);
});

test("V5 evidence contract rejects partial support for compound facets", async () => {
  const source = await readFile(new URL("prompt-contracts.ts", import.meta.url), "utf8");
  assert.match(source, /SUPPORTS requires the excerpt to establish every clause/u);
  assert.match(source, /partial or neighboring-facet support is IRRELEVANT/u);
  assert.match(source, /alternative title is IRRELEVANT to a dated title unless the periods conflict/u);
});
