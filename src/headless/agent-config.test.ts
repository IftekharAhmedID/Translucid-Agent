import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = join(process.cwd(), "runtime", "headless-opencode");

test("headless runtime keeps the DeepSeek investigator as the only semantic authority", async () => {
  const lead = await readFile(join(root, "agents", "lead-researcher.md"), "utf8");
  const cli = await readFile(join(process.cwd(), "src", "headless", "cli.ts"), "utf8");
  const config = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"));
  assert.doesNotMatch(lead, /^model:/m);
  for (const name of ["source.inventory", "source.excerpts", "investigation.plan.set", "investigation.target.add", "investigation.synthesis.begin", "investigation.finding.upsert", "investigation.progress.get", "investigation.summary.set", "investigation.commit"]) assert.match(lead, new RegExp(`${name.replaceAll(".", "\\.")}: allow`));
  for (const name of ["research.state.set", "research.state.get"]) assert.doesNotMatch(lead, new RegExp(`${name.replaceAll(".", "\\.")}: allow`));
  for (const name of ["report.summary.set", "report.finding.upsert", "report.finding.remove", "report.progress.get", "report.finalize"]) assert.doesNotMatch(lead, new RegExp(`${name.replaceAll(".", "\\.")}: allow`));
  for (const name of ["professional.profile", "github.rest", "public_records.search", "scholarly.search", "packages.inspect", "security_records.search"]) assert.match(lead, new RegExp(`${name.replaceAll(".", "\\.")}: allow`));
  assert.doesNotMatch(lead, /\btask:/);
  assert.doesNotMatch(lead, /specialist|delegate/i);
  assert.match(cli, /resolveResearchModel/);
  assert.doesNotMatch(cli, /gpt-5\.6-luna/);
  assert.doesNotMatch(cli, /research\.memo\.persist|SPECIALIST_MODEL|professional-researcher/);
  assert.equal(config.model, "translucid/deepseek-v4-pro");
  assert.equal(config.small_model, "translucid/deepseek-v4-pro");
  assert.equal(config.subagent_depth, 0);
});

test("headless runtime keeps a tool-free report writer separate from its one investigator", async () => {
  const agents = await readdir(join(root, "agents"));
  assert.deepEqual(agents.sort(), ["lead-researcher.md", "report-writer.md"]);
  const reportWriter = await readFile(join(root, "agents", "report-writer.md"), "utf8");
  assert.match(reportWriter, /model: translucid\/gpt-5\.6-luna/);
  assert.match(reportWriter, /mode: subagent/);
  assert.match(reportWriter, /"\*": deny/);
  assert.doesNotMatch(reportWriter, /: allow/);
  const config = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"));
  assert.equal(config.tools.bash, false);
  assert.equal(config.tools.edit, false);
  assert.equal(config.tools.write, false);
  assert.equal(config.compaction.prune, true);
  assert.deepEqual(config.provider.translucid.models["gpt-5.6-luna"].variants, { xhigh: { reasoningEffort: "xhigh" } });
  const plugin = await readFile(join(root, "plugin", "translucid.ts"), "utf8");
  assert.match(plugin, /source\.inventory/);
  assert.match(plugin, /research\.state\.set/);
  assert.match(plugin, /subpages: z\.number\(\)\.int\(\)\.min\(1\)\.max\(5\)/);
  assert.match(plugin, /subpageTarget: z\.array/);
  assert.match(plugin, /validatePairedSubpages/);
  assert.match(plugin, /Search output is discovery only/);
  assert.match(plugin, /Reuse one immutable local source before making a provider call/);
  assert.doesNotMatch(plugin, /task-memo|research\.memo\.persist|tool\.execute\.before/);
});

test("the DeepSeek V4 Pro comparison model is configured for maximum reasoning", async () => {
  const cli = await readFile(join(process.cwd(), "src", "headless", "cli.ts"), "utf8");
  const config = JSON.parse(await readFile(join(root, "opencode.json"), "utf8"));
  assert.match(cli, /RESEARCH_MODEL/);
  assert.ok(config.provider.translucid.models["deepseek-v4-pro"]);
  assert.equal(config.provider.translucid.models["deepseek-v4-pro"].reasoning, true);
  assert.equal(config.provider.translucid.models["deepseek-v4-pro"].tool_call, true);
  assert.deepEqual(config.provider.translucid.models["deepseek-v4-pro"].variants, { xhigh: { reasoningEffort: "max" } });
});

test("headless runtime loads the material-investigation skills and requires the initial method", async () => {
  const skills = (await readdir(join(root, "skills"))).sort();
  assert.deepEqual(skills, ["historical-footprint", "investigation-reporting", "professional-investigation"]);

  const lead = await readFile(join(root, "agents", "lead-researcher.md"), "utf8");
  const contract = await readFile(join(process.cwd(), "src", "headless", "prompt-contracts.ts"), "utf8");
  const professional = await readFile(join(root, "skills", "professional-investigation", "SKILL.md"), "utf8");
  const historical = await readFile(join(root, "skills", "historical-footprint", "SKILL.md"), "utf8");

  assert.match(lead, /load `professional-investigation`/i);
  assert.match(contract, /load `professional-investigation`/i);
  assert.match(contract, /investigation\.synthesis\.begin/i);
  assert.match(professional, /investigation-reporting/i);
  assert.match(professional, /at most one\s+logical employment-history baseline/i);
  assert.match(professional, /Tier C[\s\S]*never initiate a dedicated search[\s\S]*Preserve incidental evidence/i);
  assert.match(professional, /plausible material counter-hypothesis/i);
  assert.match(professional, /dispositive[\s\S]*alternative would not change the judgment[\s\S]*Tier-B\/C/i);
  assert.match(professional, /Investigate the material predicate exactly/i);
  assert.match(professional, /“Organised”\s+means assess material organising work/i);
  assert.match(professional, /Every claimed completed degree creates one material education target/i);
  assert.match(professional, /issuing institution[\s\S]*canonical domain|canonical domain[\s\S]*issuing institution/i);
  assert.match(professional, /institutional social[\s\S]*corroborat/i);
  assert.match(professional, /additionalQueries[\s\S]*material unresolved gap/i);
  assert.match(professional, /Qualification does not create a search quota or ritual/i);
  assert.match(professional, /forward local sweep/i);
  assert.match(professional, /reverse sweep for unresolved Tier-A targets/i);
  assert.match(professional, /artifact-oriented route/i);
  assert.match(professional, /final skill audit must check/i);
  assert.match(historical, /remaining Tier-A historical gap/i);
  assert.match(historical, /reliable metadata/i);
  assert.match(historical, /mailing lists, technical forums,\s+event programmes/i);
  assert.doesNotMatch(lead, /exhaustive factual coverage checklist/i);
  assert.doesNotMatch(contract, /complete claim checklist/i);
  assert.doesNotMatch(professional, /at most four provider calls/i);
});
