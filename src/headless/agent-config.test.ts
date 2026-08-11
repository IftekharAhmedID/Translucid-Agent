import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = join(process.cwd(), "runtime", "headless-opencode");

test("headless agents expose no database or state-machine tools", async () => {
  const files = [
    "lead-researcher.md",
    "professional-researcher.md",
    "github-researcher.md",
    "web-records-researcher.md",
    "social-researcher.md",
    "evidence-compiler.md",
    "evidence-auditor.md",
  ];
  for (const file of files) {
    const source = await readFile(join(root, "agents", file), "utf8");
    assert.doesNotMatch(source, /\b(?:claim|entity|observation|research|artifact|evidence)\.[a-z_]+\s*:\s*allow/);
  }
});

test("lead has native delegation but no provider tools, while specialists cannot delegate", async () => {
  const lead = await readFile(join(root, "agents", "lead-researcher.md"), "utf8");
  assert.match(lead, /task:\n/);
  assert.doesNotMatch(lead, /\b(?:web\.search|professional\.profile|github\.rest|social\.profile): allow/);
  for (const file of ["professional-researcher.md", "github-researcher.md", "web-records-researcher.md", "social-researcher.md"]) {
    const source = await readFile(join(root, "agents", file), "utf8");
    assert.doesNotMatch(source, /\btask:\s*allow/);
    assert.match(source, /source\.excerpts: allow/);
  }
});

test("headless OpenCode loads only the headless plugin and keeps shell and edits disabled", async () => {
  const config = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"));
  assert.deepEqual(config.plugin, ["file:///opt/investigator/runtime/headless-opencode/plugin/translucid.ts"]);
  assert.equal(config.tools.bash, false);
  assert.equal(config.tools.edit, false);
  assert.equal(config.tools.write, false);
  const plugin = await readFile(join(root, "plugin", "translucid.ts"), "utf8");
  assert.doesNotMatch(plugin, /claim\.create|research\.context|artifact\.lookup|evidence\.capture/);
  assert.match(plugin, /eight-child research limit/);
  assert.match(plugin, /two-invocation limit/);
  assert.match(plugin, /experimental\.session\.compacting/);
});
