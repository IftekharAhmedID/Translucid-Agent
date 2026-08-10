import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  assert.match(source, /at most eight/i);
  assert.match(source, /at most fifteen/i);
  assert.match(source, /parsedDocument/);
  assert.match(source, /never (?:open|request|read).*raw PDF/i);
  assert.match(source, /single assistant turn/i);
  assert.match(source, /under 1,200 characters/i);
  assert.match(source, /retry that same role once/i);
  assert.match(source, /exact semantic tool ID/i);
});

test("professional investigator starts with an explicit LinkedIn URL before broad discovery", async () => {
  const source = await readFile(new URL("../../runtime/opencode/agents/professional-investigator.md", import.meta.url), "utf8");

  assert.match(source, /explicit LinkedIn URL/i);
  assert.match(source, /professional\.profile.*first/i);
  assert.match(source, /one profile call/i);
  assert.match(source, /one retry/i);
});
