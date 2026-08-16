import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = join(process.cwd(), "runtime", "headless-opencode");

test("lead exposes native report tools while specialists keep research tools", async () => {
  const lead = await readFile(join(root, "agents", "lead-researcher.md"), "utf8");
  const cli = await readFile(join(process.cwd(), "src", "headless", "cli.ts"), "utf8");
  assert.match(lead, /^variant: xhigh$/m);
  for (const name of ["report.summary.set", "report.finding.upsert", "report.finding.remove", "report.progress.get", "report.finalize"]) assert.match(lead, new RegExp(`${name.replaceAll(".", "\\.")}: allow`));
  assert.match(lead, /source\.excerpts: allow/);
  for (const name of ["web.search", "web.fetch", "archives.search"]) assert.match(lead, new RegExp(`${name.replaceAll(".", "\\.")}: allow`));
  assert.doesNotMatch(lead, /\b(?:professional\.profile|github\.rest|public_records\.search|scholarly\.search|packages\.inspect|security_records\.search): allow/);
  assert.match(lead, /Launch exactly these default `?INITIAL`? specialist roles/i);
  assert.doesNotMatch(lead, /^steps:/m);
  assert.match(lead, /professional-researcher.*github-researcher/is);
  assert.match(lead, /Do not launch `?web-records-researcher`? in the default initial wave/i);
  assert.match(lead, /source\.excerpts.*own direct research/is);
  assert.match(cli, /\["lead-researcher", new Set\(\["web\.search", "web\.fetch", "archives\.search", "source\.excerpts", \.\.\.reportToolNames\]\)\]/);
  for (const file of ["professional-researcher.md", "github-researcher.md", "web-records-researcher.md", "social-researcher.md"]) {
    const source = await readFile(join(root, "agents", file), "utf8");
    assert.match(source, /^variant: xhigh$/m);
    assert.doesNotMatch(source, /\btask:\s*allow/);
    assert.match(source, /source\.excerpts: allow/);
    assert.match(source, /complete material handoff/i);
    assert.match(source, /materially useful observation/i);
  }
});

test("headless runtime loads one plugin and keeps shell/edit tools disabled", async () => {
  const config = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"));
  assert.deepEqual(config.plugin, ["file:///opt/investigator/runtime/headless-opencode/plugin/translucid.ts"]);
  assert.equal(config.tools.bash, false);
  assert.equal(config.tools.edit, false);
  assert.equal(config.tools.write, false);
  assert.ok(config.provider.translucid.options.timeout >= 360_000);
  assert.equal(config.provider.translucid.models["gpt-5.6-luna"].provider.npm, "@ai-sdk/openai");
  assert.equal(config.provider.translucid.npm, "@ai-sdk/openai-compatible");
  assert.deepEqual(config.provider.translucid.models["gpt-5.6-luna"].variants, { xhigh: { reasoningEffort: "xhigh" } });
  assert.deepEqual(config.provider.translucid.models["deepseek-v4-flash"].variants, { xhigh: { reasoningEffort: "xhigh" } });
  const plugin = await readFile(join(root, "plugin", "translucid.ts"), "utf8");
  assert.doesNotMatch(plugin, /claim\.create|research\.context|artifact\.lookup|evidence\.capture/);
  assert.doesNotMatch(plugin, /internal\/sources\/index/);
  assert.match(plugin, /includeDomains/);
});

test("professional and web specialists use the bounded official-domain search ladder", async () => {
  for (const file of ["professional-researcher.md", "web-records-researcher.md"]) {
    const source = await readFile(join(root, "agents", file), "utf8");
    assert.match(source, /exact-name official-domain search/i);
    assert.match(source, /includeDomains/);
    assert.match(source, /archive only/i);
  }
});

test("the headless runtime keeps only the five research skills", async () => {
  const skills = (await readdir(join(root, "skills"))).sort();
  assert.deepEqual(skills, ["employment-chronology", "entity-resolution", "public-record-verification", "source-evaluation", "technical-contribution"]);
  for (const name of skills) assert.match(await readFile(join(root, "skills", name, "SKILL.md"), "utf8"), new RegExp(`^---\\nname: ${name}\\n`, "m"));
  const start = await readFile(join(process.cwd(), "runtime", "start.sh"), "utf8");
  assert.match(start, /headless-opencode\/skills/);
  assert.doesNotMatch(start, /runtime\/opencode|CASE_INSTRUCTIONS|extract-input/);
});

test("headless research uses async prompts and durable memo handoff", async () => {
  const controller = await readFile(join(process.cwd(), "src", "headless", "controller.ts"), "utf8");
  assert.match(controller, /client\.session\.promptAsync\(/);
  assert.doesNotMatch(controller, /client\.session\.messages\(/);
  assert.match(controller, /report\.progress\.get/);
});
