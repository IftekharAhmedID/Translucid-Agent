import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
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

test("compiler and auditor can read bounded source excerpts but have no network tools", async () => {
  for (const file of ["evidence-compiler.md", "evidence-auditor.md"]) {
    const source = await readFile(join(root, "agents", file), "utf8");
    assert.match(source, /source\.excerpts: allow/);
    assert.doesNotMatch(source, /\b(?:web\.|professional\.|github\.|social\.|archives\.|public_records\.|scholarly\.|packages\.|security_records\.)[a-z_]+:\s*allow/);
  }
  const cli = await readFile(join(process.cwd(), "src", "headless", "cli.ts"), "utf8");
  assert.match(cli, /\["evidence-compiler", new Set\(\["source\.excerpts"\]\)\]/);
  assert.match(cli, /\["evidence-auditor", new Set\(\["source\.excerpts"\]\)\]/);
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
  assert.doesNotMatch(plugin, /internal\/sources\/index/);
});

test("exactly five headless skills are copied and discoverable only by permitted agents", async () => {
  const expectedSkills = ["employment-chronology", "entity-resolution", "public-record-verification", "source-evaluation", "technical-contribution"];
  assert.deepEqual((await readdir(join(root, "skills"))).sort(), expectedSkills);
  for (const name of expectedSkills) {
    const source = await readFile(join(root, "skills", name, "SKILL.md"), "utf8");
    assert.match(source, new RegExp(`^---\\nname: ${name}\\n`, "m"));
  }

  const expected = new Map<string, string[]>([
    ["lead-researcher.md", expectedSkills],
    ["professional-researcher.md", ["employment-chronology", "entity-resolution", "source-evaluation"]],
    ["github-researcher.md", ["entity-resolution", "source-evaluation", "technical-contribution"]],
    ["web-records-researcher.md", ["entity-resolution", "public-record-verification", "source-evaluation"]],
    ["social-researcher.md", ["entity-resolution", "source-evaluation"]],
    ["evidence-compiler.md", ["entity-resolution", "source-evaluation"]],
    ["evidence-auditor.md", ["entity-resolution", "source-evaluation"]],
    ["document-vision.md", []],
  ]);
  for (const [file, allowed] of expected) {
    const source = await readFile(join(root, "agents", file), "utf8");
    const block = source.match(/^  skill:\n((?:    .*\n)+)/m)?.[1] ?? "";
    const actual = [...block.matchAll(/^    ([a-z0-9-]+): allow$/gm)].map((match) => match[1]!).sort();
    assert.deepEqual(actual, [...allowed].sort(), file);
  }

  const start = await readFile(join(process.cwd(), "runtime", "start.sh"), "utf8");
  assert.match(start, /headless-opencode\/skills/);
});

test("lead uses a bounded checklist and the three default specialists with conditional social research", async () => {
  const lead = await readFile(join(root, "agents", "lead-researcher.md"), "utf8");
  assert.match(lead, /15[–-]30/);
  assert.match(lead, /professional.*GitHub.*web records.*in parallel/is);
  assert.match(lead, /social.*only/is);
});
