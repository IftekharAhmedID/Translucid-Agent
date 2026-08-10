import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

const runId = process.argv[2];
if (!runId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
  throw new Error("Usage: npm run attach -- <active-local-run-id>");
}

const credentialPath = resolve(".debug", "attach", `${runId}.json`);
const credential = JSON.parse(await readFile(credentialPath, "utf8")) as { openCodeUrl?: unknown; password?: unknown };
if (typeof credential.openCodeUrl !== "string" || !credential.openCodeUrl.startsWith("http://127.0.0.1:") || typeof credential.password !== "string") {
  throw new Error("The local attach credential is invalid.");
}

const authorization = `Basic ${Buffer.from(`opencode:${credential.password}`).toString("base64")}`;
const client = createOpencodeClient({ baseUrl: credential.openCodeUrl, headers: { authorization }, throwOnError: false });
let lead;
for (let attempt = 0; attempt < 60 && !lead; attempt += 1) {
  const sessions = await client.session.list({ directory: "/workspace/case" });
  lead = sessions.data
    ?.filter((session) => session.title === "Translucid lead investigation")
    .sort((left, right) => right.time.created - left.time.created)
    .at(0);
  if (!lead) await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
}
if (!lead) throw new Error("The local investigation has not created its lead OpenCode session yet.");

const child = spawn(resolve("node_modules", ".bin", "opencode"), ["attach", credential.openCodeUrl, "--session", lead.id], {
  env: { ...process.env, OPENCODE_SERVER_PASSWORD: credential.password },
  stdio: "inherit",
});

const exitCode = await new Promise<number>((done, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => done(code ?? 1));
});
process.exitCode = exitCode;
