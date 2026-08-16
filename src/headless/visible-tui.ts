import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import type { RunHandle } from "../runtime/types.ts";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function buildVisibleTuiCommand(handle: RunHandle, password: string, sessionId: string): string {
  const opencode = resolve(process.cwd(), "node_modules/.bin/opencode");
  return [
    `cd ${shellQuote(process.cwd())}`,
    `env OPENCODE_SERVER_PASSWORD=${shellQuote(password)} ${shellQuote(opencode)} attach ${shellQuote(handle.openCodeUrl)} --session ${shellQuote(sessionId)}`,
    "printf '\\nOpenCode session ended.\\n'",
    "exec ${SHELL:-/bin/zsh}",
  ].join("; ");
}

export function attachOpenCodeTui(handle: RunHandle, password: string, sessionId: string): ChildProcess {
  const command = buildVisibleTuiCommand(handle, password, sessionId);
  if (process.platform === "darwin") {
    const appleScript = `tell application "Terminal" to do script ${JSON.stringify(command)}`;
    return spawn("osascript", ["-e", appleScript], { stdio: "ignore" });
  }
  return spawn(resolve(process.cwd(), "node_modules/.bin/opencode"), ["attach", handle.openCodeUrl, "--session", sessionId], {
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
    stdio: "inherit",
  });
}
