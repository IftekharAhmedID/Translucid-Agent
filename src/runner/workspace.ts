import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getSql } from "../db/client.ts";

export async function prepareCaseWorkspace(investigationId: string, runId: string): Promise<string> {
  const [investigation] = await getSql()<Array<{
    submissionKind: string;
    submissionRaw: string;
    submissionNormalized: string;
    submissionSha256: string;
    resumeArtifactId: string | null;
  }>>`
    SELECT submission_kind AS "submissionKind", submission_raw AS "submissionRaw",
      submission_normalized AS "submissionNormalized", submission_sha256 AS "submissionSha256",
      resume_artifact_id AS "resumeArtifactId"
    FROM investigations WHERE id = ${investigationId} AND latest_run_id = ${runId}
  `;
  if (!investigation) throw new Error("Investigation intake not found.");
  const directory = await mkdtemp(join(tmpdir(), `translucid-${runId}-`));
  const inputDirectory = join(directory, "input");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(inputDirectory, { recursive: true }));
  await Promise.all([
    writeFile(join(inputDirectory, "submission.raw.txt"), investigation.submissionRaw),
    writeFile(join(inputDirectory, investigation.submissionKind === "JSON" ? "submission.normalized.json" : "submission.normalized.txt"), investigation.submissionNormalized),
  ]);
  let pdfPath: string | undefined;
  if (investigation.resumeArtifactId) {
    const [artifact] = await getSql()<Array<{ contentBytes: Uint8Array; sha256: string }>>`
      SELECT content_bytes AS "contentBytes", sha256 FROM artifacts
      WHERE id = ${investigation.resumeArtifactId} AND investigation_id = ${investigationId}
    `;
    if (!artifact) throw new Error("Original PDF artifact is missing.");
    pdfPath = "/workspace/case/input/resume.original.pdf";
    await writeFile(join(inputDirectory, "resume.original.pdf"), Buffer.from(artifact.contentBytes));
  }
  await writeFile(join(inputDirectory, "intake.json"), JSON.stringify({
    investigationId,
    runId,
    classification: "SYNTHETIC",
    submission: {
      kind: investigation.submissionKind,
      rawPath: "/workspace/case/input/submission.raw.txt",
      normalizedPath: `/workspace/case/input/${investigation.submissionKind === "JSON" ? "submission.normalized.json" : "submission.normalized.txt"}`,
      sha256: investigation.submissionSha256,
    },
    pdfPath,
  }, null, 2));
  return directory;
}
