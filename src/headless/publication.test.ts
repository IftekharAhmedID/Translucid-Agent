import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { publishFinalizationProvenance } from "./incremental-pipeline.ts";

for (const file of ["cli.ts", "finalize-cli.ts"]) {
  test(`${file} verifies the temporary PDF and publishes result.json last`, async () => {
    const source = await readFile(join(process.cwd(), "src", "headless", file), "utf8");
    const steps = [
      "atomicWrite(reportTemporaryPath",
      "verifyInvestigationReport(await readFile(reportTemporaryPath))",
      "await runtime.stop(handle)",
      "provenance\", \"report.json",
      "reportStore.markPublished()",
      "rename(reportTemporaryPath, reportPath)",
      "atomicWrite(resultPath",
    ].map((text) => source.indexOf(text));
    assert.equal(steps.every((index) => index >= 0), true);
    assert.deepEqual(steps, [...steps].sort((left, right) => left - right));
    assert.doesNotMatch(source, /fallback.*(?:v3|v4)/iu);
  });
}

test("V5.1 summaries are deterministic host output", async () => {
  const source = await readFile(join(process.cwd(), "src", "headless", "incremental-pipeline.ts"), "utf8");
  assert.match(source, /buildDeterministicSummaryTimeline\(claims, evidence/u);
  assert.match(source, /rejectedCitations: assembled\.rejectedCandidateCount/u);
  assert.doesNotMatch(source, /SUMMARY_TIMELINE_PROMPT_CONTRACT/u);
});

test("V5 resumes an audit only when its dependency fingerprint matches", async () => {
  const source = await readFile(join(process.cwd(), "src", "headless", "incremental-pipeline.ts"), "utf8");
  assert.match(source, /manifest\.stages\.audit\?\.fingerprint === auditFingerprint[\s\S]*readJsonIfPresent\(join\(v5Root, "audit\.json"\)/u);
});

test("V5.1 persists bounded pre-request diagnostics outside disposable and published stage records", async () => {
  const source = await readFile(join(process.cwd(), "src", "headless", "incremental-pipeline.ts"), "utf8");
  assert.match(source, /\.work", "finalization", "attempts", "v5\.1"/u);
  assert.match(source, /status: "STARTED"/u);
  assert.match(source, /"TRANSPORT_ERROR"/u);
  assert.match(source, /atomicJson\(attemptPath/u);
  assert.doesNotMatch(source, /join\(v5Root, "attempts"\)/u);
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

test("V5.1 evidence retrieval scans the immutable corpus and fingerprints bundle packets", async () => {
  const pipeline = await readFile(new URL("incremental-pipeline.ts", import.meta.url), "utf8");
  const store = await readFile(new URL("source-store.ts", import.meta.url), "utf8");
  assert.match(pipeline, /whole-corpus-bundle-v1/u);
  assert.match(pipeline, /findBundleExcerpts/u);
  assert.match(store, /const unique = new Map/u);
  assert.match(store, /unique\.has\(candidate\.ref\)/u);
});

test("V5.1 evidence contract requires atomic facets and preserves context-only candidates", async () => {
  const source = await readFile(new URL("prompt-contracts.ts", import.meta.url), "utf8");
  assert.match(source, /one independently adjudicable predicate/u);
  assert.match(source, /CONTEXT and DISCOVERY_ONLY sources can never SUPPORT or CONTRADICT/u);
  assert.match(source, /alternative title is IRRELEVANT to a dated title unless the periods conflict/u);
});

test("finalization provenance replaces stale stage files", async () => {
  const root = await mkdtemp(join(tmpdir(), "translucid-provenance-"));
  try {
    await mkdir(join(root, ".work", "finalization", "v5"), { recursive: true });
    await mkdir(join(root, "provenance", "finalization"), { recursive: true });
    await writeFile(join(root, ".work", "finalization", "v5", "manifest.json"), "current");
    await writeFile(join(root, "provenance", "finalization", "stale.json"), "stale");

    await publishFinalizationProvenance(root);

    assert.deepEqual(await readdir(join(root, "provenance", "finalization")), ["manifest.json"]);
    assert.equal(await readFile(join(root, "provenance", "finalization", "manifest.json"), "utf8"), "current");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
