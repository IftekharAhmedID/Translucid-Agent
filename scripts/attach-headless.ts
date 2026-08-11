import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

const runId = process.argv[2];
if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("Usage: npm run attach -- <active-headless-run-id>");
const credential = JSON.parse(await readFile(resolve(".debug", "headless", `${runId}.json`), "utf8")) as { openCodeUrl?: unknown; password?: unknown; title?: unknown };
if (typeof credential.openCodeUrl !== "string" || !credential.openCodeUrl.startsWith("http://127.0.0.1:") || typeof credential.password !== "string") throw new Error("The headless attach credential is invalid or the run is no longer active.");
const authorization = `Basic ${Buffer.from(`opencode:${credential.password}`).toString("base64")}`;
const client = createOpencodeClient({ baseUrl: credential.openCodeUrl, headers: { authorization }, throwOnError: false });
let lead;
for (let attempt = 0; attempt < 60 && !lead; attempt += 1) {
  const sessions = await client.session.list({ directory: "/workspace/case" });
  lead = sessions.data?.filter((session) => session.title === (credential.title ?? "Headless lead research")).sort((left, right) => right.time.created - left.time.created).at(0);
  if (!lead) await new Promise((done) => setTimeout(done, 1_000));
}
if (!lead) throw new Error("The headless run has not created its lead session yet.");
const child = spawn(resolve("node_modules", ".bin", "opencode"), ["attach", credential.openCodeUrl, "--session", lead.id], { env: { ...process.env, OPENCODE_SERVER_PASSWORD: credential.password }, stdio: "inherit" });
process.exitCode = await new Promise<number>((done, reject) => { child.once("error", reject); child.once("exit", (code) => done(code ?? 1)); });
