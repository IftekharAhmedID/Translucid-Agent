import assert from "node:assert/strict";
import test from "node:test";

import { parseInvestigationArguments } from "./cli-options.ts";

test("parses the documented headless CLI contract", () => {
  assert.deepEqual(parseInvestigationArguments([
    "--resume", "/tmp/resume.pdf",
    "--classification", "public-professional",
    "--provider-mode", "live",
    "--runtime", "local",
    "--output", "./runs",
    "--watch",
    "--keep-debug",
  ]), {
    resumePath: "/tmp/resume.pdf",
    classification: "PUBLIC_PROFESSIONAL",
    providerMode: "live",
    runtime: "LOCAL",
    outputDirectory: "./runs",
    watch: true,
    keepDebug: true,
  });
});

test("defaults to fixture, local runtime, and ./runs", () => {
  const parsed = parseInvestigationArguments(["--submission", "/tmp/candidate.txt", "--classification", "synthetic"]);
  assert.equal(parsed.providerMode, "fixture");
  assert.equal(parsed.runtime, "LOCAL");
  assert.equal(parsed.outputDirectory, "./runs");
  assert.equal(parsed.watch, false);
});

test("requires input and classification and rejects incompatible public fixture execution", () => {
  assert.throws(() => parseInvestigationArguments(["--classification", "synthetic"]), /at least one input/i);
  assert.throws(() => parseInvestigationArguments(["--submission", "/tmp/a.txt"]), /classification is required/i);
  assert.throws(() => parseInvestigationArguments(["--submission", "/tmp/a.txt", "--classification", "public-professional"]), /requires live provider mode/i);
  assert.throws(() => parseInvestigationArguments(["--submission", "/tmp/a.txt", "--classification", "synthetic", "--unknown"]), /unknown argument/i);
});
