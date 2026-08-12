import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";

const root = process.cwd();
const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
const scopeIndex = process.argv.indexOf("--scope");
const scope = scopeIndex >= 0 ? process.argv[scopeIndex + 1] : "full";
if (scope !== "full" && scope !== "research") throw new Error("Runtime manifest scope must be full or research.");
const criticalRoots = ["Dockerfile", "package-lock.json", "runtime"];
const researchOnlyFiles = new Set([
  "runtime/headless-opencode/agents/evidence-compiler.md",
  "runtime/headless-opencode/agents/evidence-auditor.md",
]);

async function filesAt(path: string): Promise<string[]> {
  const absolute = resolve(root, path);
  const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
  if (!entries.length) return [absolute];
  const nested = await Promise.all(entries.map((entry) => filesAt(resolve(absolute, entry.name))));
  return nested.flat();
}

const files = (await Promise.all(criticalRoots.map(filesAt))).flat()
  .filter((file) => scope === "full" || !researchOnlyFiles.has(relative(root, file)))
  .sort();
const hashes: Record<string, string> = {};
for (const file of files) {
  const bytes = await readFile(file);
  hashes[relative(root, file)] = createHash("sha256").update(bytes).digest("hex");
}
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };
const manifest = {
  node: `v${process.versions.node.split(".")[0]}`,
  packages: Object.fromEntries(["opencode-ai", "@opencode-ai/sdk", "@opencode-ai/plugin", "pdfjs-dist"].map((name) => [name, packageJson.dependencies[name]])),
  files: hashes,
};
const canonical = JSON.stringify(manifest);
const result = { ...manifest, manifestHash: createHash("sha256").update(canonical).digest("hex") };
const formatted = `${JSON.stringify(result, null, 2)}\n`;
if (outputPath) await writeFile(outputPath, formatted);
else process.stdout.write(formatted);
