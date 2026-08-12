import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import PDFDocument from "pdfkit";

import { createRunWorkspace, openRunWorkspace, removeRunDiagnostics, sealRunFailure } from "./run-workspace.ts";

async function writeSyntheticPdf(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const document = new PDFDocument({ autoFirstPage: true });
    const output = createWriteStream(path, { mode: 0o600 });
    output.once("finish", resolve);
    output.once("error", reject);
    document.pipe(output);
    document.fontSize(14).text("Synthetic Candidate");
    document.fontSize(11).text("Principal Engineer at Example Corp from 2020 to 2024.");
    document.end();
  });
}

test("creates a self-contained file-backed run from a text submission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-run-"));
  try {
    const submission = join(directory, "candidate.txt");
    await writeFile(submission, "Synthetic Candidate\nPrincipal Engineer at Example Corp\n");
    const workspace = await createRunWorkspace({
      outputDirectory: join(directory, "runs"),
      submissionPath: submission,
      classification: "SYNTHETIC",
      runtime: "LOCAL",
      startedAt: "2026-08-11T12:00:00.000Z",
      runId: "run-synthetic",
    });

    assert.equal(workspace.runId, "run-synthetic");
    assert.match(workspace.inputSha256, /^[a-f0-9]{64}$/);
    assert.equal(await readFile(join(workspace.root, "input", "document.txt"), "utf8"), "Synthetic Candidate\nPrincipal Engineer at Example Corp\n");
    const document = JSON.parse(await readFile(join(workspace.root, "input", "document.json"), "utf8"));
    assert.equal(document.sourceType, "TEXT_SUBMISSION");
    assert.equal(document.pages[0].text, "Synthetic Candidate\nPrincipal Engineer at Example Corp\n");
    const manifest = JSON.parse(await readFile(join(workspace.root, "input", "manifest.json"), "utf8"));
    assert.equal(manifest.runId, "run-synthetic");
    assert.equal(manifest.classification, "SYNTHETIC");
    assert.equal(manifest.inputSha256, workspace.inputSha256);
    await stat(join(workspace.root, "sources", "manifest.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("normalizes JSON submissions without losing the original input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-run-json-"));
  try {
    const submission = join(directory, "candidate.json");
    await writeFile(submission, '{"name":"Synthetic Candidate","role":"Engineer"}');
    const workspace = await createRunWorkspace({
      outputDirectory: join(directory, "runs"),
      submissionPath: submission,
      classification: "SYNTHETIC",
      runtime: "LOCAL",
      runId: "run-json",
    });

    assert.equal(await readFile(join(workspace.root, "input", "submission.original.json"), "utf8"), '{"name":"Synthetic Candidate","role":"Engineer"}');
    assert.deepEqual(JSON.parse(await readFile(join(workspace.root, "input", "document.txt"), "utf8")), {
      name: "Synthetic Candidate",
      role: "Engineer",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("extracts a PDF once while preserving the immutable original", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-run-pdf-"));
  try {
    const resume = join(directory, "synthetic.pdf");
    await writeSyntheticPdf(resume);
    const originalBytes = await readFile(resume);
    const workspace = await createRunWorkspace({
      outputDirectory: join(directory, "runs"),
      resumePath: resume,
      classification: "SYNTHETIC",
      runtime: "LOCAL",
      runId: "run-pdf",
    });

    assert.deepEqual(await readFile(join(workspace.root, "input", "original.pdf")), originalBytes);
    assert.match(await readFile(join(workspace.root, "input", "document.txt"), "utf8"), /Principal Engineer at Example Corp/);
    const document = JSON.parse(await readFile(join(workspace.root, "input", "document.json"), "utf8"));
    assert.equal(document.pageCount, 1);
    assert.equal(document.pages[0].sparse, true);
    assert.equal(document.pages[0].imagePath, "/workspace/case/input/sparse-pages/page-001.png");
    await stat(join(workspace.root, "input", "sparse-pages", "page-001.png"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("includes a supplemental submission when a resume and submission are provided", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-run-combined-"));
  try {
    const resume = join(directory, "synthetic.pdf");
    const submission = join(directory, "supplement.json");
    await writeSyntheticPdf(resume);
    await writeFile(submission, '{"portfolio":"https://example.test/work","note":"Led twelve engineers"}');
    const workspace = await createRunWorkspace({
      outputDirectory: join(directory, "runs"),
      resumePath: resume,
      submissionPath: submission,
      classification: "SYNTHETIC",
      runtime: "LOCAL",
      runId: "run-combined",
    });

    const text = await readFile(join(workspace.root, "input", "document.txt"), "utf8");
    assert.match(text, /Supplemental JSON submission/);
    assert.match(text, /Led twelve engineers/);
    const document = JSON.parse(await readFile(join(workspace.root, "input", "document.json"), "utf8"));
    assert.equal(document.supplementalSubmission.sourceType, "JSON_SUBMISSION");
    assert.match(document.supplementalSubmission.text, /Led twelve engineers/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("requires an input and refuses to overwrite an existing run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-run-validation-"));
  try {
    await assert.rejects(
      createRunWorkspace({ outputDirectory: directory, classification: "SYNTHETIC", runtime: "LOCAL", runId: "missing" }),
      /at least one input/i,
    );
    const submission = join(directory, "candidate.txt");
    await writeFile(submission, "candidate");
    await createRunWorkspace({ outputDirectory: directory, submissionPath: submission, classification: "SYNTHETIC", runtime: "LOCAL", runId: "duplicate" });
    await assert.rejects(
      createRunWorkspace({ outputDirectory: directory, submissionPath: submission, classification: "SYNTHETIC", runtime: "LOCAL", runId: "duplicate" }),
      /already exists/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("opens an existing run without changing its immutable input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-open-run-"));
  try {
    const submission = join(directory, "submission.txt");
    await writeFile(submission, "Synthetic Candidate worked at Acme Labs.");
    const created = await createRunWorkspace({
      outputDirectory: directory,
      submissionPath: submission,
      classification: "SYNTHETIC",
      runtime: "LOCAL",
      runId: "existing-run",
      startedAt: "2026-08-11T12:00:00.000Z",
    });
    const opened = await openRunWorkspace(created.root);
    assert.equal(opened.runId, "existing-run");
    assert.equal(opened.runtime, "LOCAL");
    assert.equal(opened.classification, "SYNTHETIC");
    assert.equal(opened.inputSha256, created.inputSha256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("seals a failure record with bounded diagnostics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-run-failure-"));
  try {
    const root = join(directory, "run");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(root, { recursive: true }));
    await sealRunFailure(root, {
      runId: "run-failed",
      code: "RUNTIME_FAILED",
      message: "runtime stopped",
      phase: "RESEARCH",
      cancelled: false,
      diagnostics: { stderr: "x".repeat(20_000), token: "must-not-be-copied" },
    });
    const failure = JSON.parse(await readFile(join(root, "failure.json"), "utf8"));
    assert.equal(failure.code, "RUNTIME_FAILED");
    assert.ok(JSON.stringify(failure).length < 12_000);
    assert.doesNotMatch(JSON.stringify(failure), /must-not-be-copied/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("successful cleanup leaves only the authoritative run bundle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-run-cleanup-"));
  try {
    for (const path of [".bun/install", ".cache/opencode", ".config/opencode", ".local/share/opencode", ".npm/_cacache", ".opencode", ".work/memos", "output"]) {
      await mkdir(join(directory, path), { recursive: true });
      await writeFile(join(directory, path, "diagnostic"), "temporary");
    }
    for (const path of ["INSTRUCTIONS.md", "opencode.json", "runtime-manifest.json"]) await writeFile(join(directory, path), "temporary");
    for (const path of ["input", "sources"]) await mkdir(join(directory, path));
    for (const path of ["result.json", "report.pdf"]) await writeFile(join(directory, path), "authoritative");

    await removeRunDiagnostics(directory);

    assert.deepEqual((await import("node:fs/promises").then(({ readdir }) => readdir(directory))).sort(), ["input", "report.pdf", "result.json", "sources"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
