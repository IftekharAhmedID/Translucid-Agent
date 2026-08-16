import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryPattern = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,99})\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const refPattern = /^(?![-/])(?!.*\.\.)(?!.*\/\.)(?!.*\.lock(?:\/|$))[A-Za-z0-9._/-]{1,200}$/;

export function validateGitHubRepository(repository: string): string {
  const value = repository.trim();
  if (!repositoryPattern.test(value)) throw new Error("Repository must be a GitHub owner/name pair.");
  return value;
}

export function githubRepositoryUrl(repository: string): string {
  return `https://github.com/${validateGitHubRepository(repository)}.git`;
}

export async function inspectGitHubRepository(input: {
  repository: string;
  ref?: string;
  authorHint?: string;
  signal: AbortSignal;
}): Promise<Record<string, unknown>> {
  const repository = validateGitHubRepository(input.repository);
  const ref = input.ref?.trim();
  if (ref && !refPattern.test(ref)) throw new Error("Repository ref is invalid.");
  const authorHint = input.authorHint?.trim();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "translucid-github-"));
  const checkout = join(temporaryDirectory, "repository");
  const environment = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
  const runGit = async (arguments_: string[], timeout = 90_000): Promise<string> => {
    const { stdout } = await execFileAsync("git", arguments_, {
      env: environment,
      encoding: "utf8",
      maxBuffer: 5 * 1024 * 1024,
      timeout,
      signal: input.signal,
    });
    return stdout;
  };

  try {
    const cloneArguments = ["-c", "core.hooksPath=/dev/null", "clone", "--filter=blob:none", "--no-tags", "--single-branch", "--depth", "200"];
    if (ref) cloneArguments.push("--branch", ref);
    cloneArguments.push(githubRepositoryUrl(repository), checkout);
    await runGit(cloneArguments);

    const head = (await runGit(["-C", checkout, "rev-parse", "HEAD"], 15_000)).trim();
    const recentHistory = await runGit([
      "-C", checkout, "log", "--max-count=200", "--date=iso-strict",
      "--format=%H%x09%aN%x09%aE%x09%aI%x09%s", "--stat", "--no-renames",
    ], 30_000);
    let authoredPatchExcerpt: string | undefined;
    let patchExcerptTruncated = false;
    if (authorHint) {
      const escapedAuthor = authorHint.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
      const patches = await runGit([
        "-C", checkout, "log", `--author=${escapedAuthor}`, "--max-count=5",
        "--date=iso-strict", "--format=commit %H%nAuthor: %aN <%aE>%nDate: %aI%nSubject: %s%n",
        "--patch", "--unified=3", "--no-renames", "--",
      ], 45_000);
      patchExcerptTruncated = patches.length > 1_500_000;
      authoredPatchExcerpt = patches.slice(0, 1_500_000);
    }
    return {
      repository,
      publicCloneUrl: githubRepositoryUrl(repository),
      ref: ref ?? null,
      head,
      recentHistory: recentHistory.slice(0, 1_500_000),
      authoredPatchExcerpt,
      patchExcerptTruncated,
      constraints: { depth: 200, maximumAuthoredPatches: 5, executableRepositoryContentRan: false },
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
