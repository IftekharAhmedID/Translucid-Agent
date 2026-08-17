import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = join(process.cwd(), "runtime", "headless-opencode");

test("headless runtime exposes one Luna investigator with local recall and no task route", async () => {
  const lead = await readFile(join(root, "agents", "lead-researcher.md"), "utf8");
  const cli = await readFile(join(process.cwd(), "src", "headless", "cli.ts"), "utf8");
  const config = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"));
  assert.match(lead, /model: translucid\/gpt-5\.6-luna/);
  for (const name of ["source.inventory", "source.excerpts", "research.state.set", "report.summary.set", "report.finding.upsert", "report.finding.remove", "report.progress.get", "report.finalize"]) assert.match(lead, new RegExp(`${name.replaceAll(".", "\\.")}: allow`));
  for (const name of ["professional.profile", "github.rest", "public_records.search", "scholarly.search", "packages.inspect", "security_records.search"]) assert.match(lead, new RegExp(`${name.replaceAll(".", "\\.")}: allow`));
  assert.doesNotMatch(lead, /\btask:/);
  assert.doesNotMatch(lead, /specialist|delegate/i);
  assert.match(cli, /gpt-5\.6-luna/);
  assert.doesNotMatch(cli, /research\.memo\.persist|SPECIALIST_MODEL|professional-researcher/);
  assert.equal(config.model, "translucid/gpt-5.6-luna");
  assert.equal(config.small_model, "translucid/gpt-5.6-luna");
  assert.equal(config.subagent_depth, 0);
});

test("headless runtime keeps only one investigator agent file and shell/edit tools disabled", async () => {
  const agents = await readdir(join(root, "agents"));
  assert.deepEqual(agents, ["lead-researcher.md"]);
  const config = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"));
  assert.equal(config.tools.bash, false);
  assert.equal(config.tools.edit, false);
  assert.equal(config.tools.write, false);
  assert.equal(config.compaction.prune, true);
  assert.deepEqual(config.provider.translucid.models["gpt-5.6-luna"].variants, { xhigh: { reasoningEffort: "xhigh" } });
  const plugin = await readFile(join(root, "plugin", "translucid.ts"), "utf8");
  assert.match(plugin, /source\.inventory/);
  assert.match(plugin, /research\.state\.set/);
  assert.doesNotMatch(plugin, /task-memo|research\.memo\.persist|tool\.execute\.before/);
});

test("headless runtime loads the five research skills", async () => {
  const skills = (await readdir(join(root, "skills"))).sort();
  assert.deepEqual(skills, ["employment-chronology", "entity-resolution", "public-record-verification", "source-evaluation", "technical-contribution"]);
});
