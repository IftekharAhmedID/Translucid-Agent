import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const researchAgents = [
  "professional-investigator",
  "github-investigator",
  "web-records-investigator",
  "social-investigator",
] as const;

for (const agent of researchAgents) {
  test(`${agent} can read durable research question IDs`, async () => {
    const source = await readFile(new URL(`../../runtime/opencode/agents/${agent}.md`, import.meta.url), "utf8");

    assert.match(source, /^  research\.list: allow$/m);
  });
}

test("lead investigator is explicitly bounded and receives structured text rather than a PDF", async () => {
  const source = await readFile(new URL("../../runtime/opencode/agents/lead-investigator.md", import.meta.url), "utf8");

  assert.match(source, /claim-decomposition/);
  assert.match(source, /document-analysis/);
  assert.match(source, /at most 12 questions/i);
  assert.match(source, /defensive cap of 60/i);
  assert.match(source, /parsedDocument/);
  assert.match(source, /never (?:open|request|read).*raw PDF/i);
  assert.match(source, /single assistant turn/i);
  assert.match(source, /under 1,200 characters/i);
  assert.match(source, /research\.begin_wave/);
  assert.match(source, /No third wave/i);
  assert.match(source, /exact semantic tool ID/i);
  assert.match(source, /claim coverage audit/i);
  assert.match(source, /every page and section/i);
  assert.match(source, /independently adjudicable/i);
  assert.match(source, /split audit/i);
  assert.match(source, /do not begin.*research wave.*coverage/i);
  assert.match(source, /CLAIM_COVERAGE_COMPLETE/);
});

test("every DeepSeek investigation role uses medium reasoning and none uses max", async () => {
  const directory = new URL("../../runtime/opencode/agents/", import.meta.url);
  const agentFiles = (await readdir(directory)).filter((name) => name.endsWith(".md"));
  for (const file of agentFiles) {
    const source = await readFile(new URL(file, directory), "utf8");
    if (!source.includes("model: translucid/deepseek-v4-flash")) continue;
    assert.match(source, /variant:\s*medium/);
    assert.doesNotMatch(source, /variant:\s*max/);
  }
});

test("professional investigator starts with an explicit LinkedIn URL before broad discovery", async () => {
  const source = await readFile(new URL("../../runtime/opencode/agents/professional-investigator.md", import.meta.url), "utf8");

  assert.match(source, /explicit LinkedIn URL/i);
  assert.match(source, /professional\.profile/i);
  assert.match(source, /exact material field/i);
  assert.match(source, /single conditional Bright Data fallback/i);
  assert.match(source, /one retry/i);
});

test("fresh adjudicator is restricted to evidence linked inside each claim packet", async () => {
  const source = await readFile(new URL("../../runtime/opencode/agents/fresh-adjudicator.md", import.meta.url), "utf8");

  assert.match(source, /eligibleEvidenceIds/);
  assert.match(source, /same packet/i);
  assert.match(source, /UNRESOLVED with empty citation arrays/i);
});

test("evidence critic reports exceptions without echoing accepted evidence", async () => {
  const source = await readFile(new URL("../../runtime/opencode/agents/evidence-critic.md", import.meta.url), "utf8");
  assert.match(source, /accepts every selected evidence row by default/i);
  assert.match(source, /never echo an accepted-evidence list/i);
});

for (const agent of ["lead-investigator", ...researchAgents]) {
  test(`${agent} never refetches or probes saved tool output to recover artifact IDs`, async () => {
    const source = await readFile(new URL(`../../runtime/opencode/agents/${agent}.md`, import.meta.url), "utf8");

    assert.match(source, /never refetch.*artifact ID/i);
    assert.match(source, /do not (?:read|probe).*tool-output/i);
    assert.match(source, /move to the next independent question/i);
  });
}
