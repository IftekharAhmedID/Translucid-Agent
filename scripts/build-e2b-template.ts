import { Template, defaultBuildLogger } from "e2b";

const apiKey = process.env.E2B_API_KEY;
if (!apiKey) throw new Error("E2B_API_KEY is required to build the investigator template.");

const name = process.argv[2] || "translucid-investigator";
if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(name)) throw new Error("Template name must use lowercase letters, numbers, and hyphens.");

const template = Template({ fileContextPath: process.cwd() }).fromDockerfile("Dockerfile");
const result = await Template.build(template, name, {
  apiKey,
  cpuCount: 2,
  memoryMB: 2_048,
  onBuildLogs: defaultBuildLogger(),
});

process.stdout.write(`${JSON.stringify({ name: result.name, templateId: result.templateId, buildId: result.buildId }, null, 2)}\n`);
