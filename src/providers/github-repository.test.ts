import assert from "node:assert/strict";
import test from "node:test";

import { githubRepositoryUrl, validateGitHubRepository } from "./github-repository.ts";

test("GitHub repository wrapper accepts only a public owner/name pair", () => {
  assert.equal(validateGitHubRepository("openai/codex"), "openai/codex");
  assert.equal(githubRepositoryUrl("openai/codex"), "https://github.com/openai/codex.git");
  assert.throws(() => validateGitHubRepository("https://evil.test/repo"));
  assert.throws(() => validateGitHubRepository("owner/repo/extra"));
  assert.throws(() => validateGitHubRepository("../repo"));
});
