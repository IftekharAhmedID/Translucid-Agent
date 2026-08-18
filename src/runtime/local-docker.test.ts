import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalDockerRuntime } from "./local-docker.ts";

function runtimeInput(caseDirectory: string) {
  return {
    investigationId: "investigation-test",
    runId: "run-test",
    caseDirectory,
    gatewayUrl: "http://127.0.0.1:3210",
    caseToken: "case-token",
    openCodePassword: "open-code-password",
    expectedManifestHash: "fake-manifest",
    timeoutMs: 5_000,
    mode: "headless" as const,
  };
}

test("reports a missing Docker CLI before attempting to start a container", async () => {
  const previousPath = process.env.PATH;
  process.env.PATH = "/definitely-missing-translucid-path";
  try {
    await assert.rejects(
      new LocalDockerRuntime().start(runtimeInput(process.cwd())),
      (error: unknown) => error instanceof Error && error.name === "LOCAL_DOCKER_CLI_UNAVAILABLE" && /PATH/.test(error.message),
    );
  } finally {
    process.env.PATH = previousPath;
  }
});

test("allows a later local start after an image build failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translucid-local-docker-test-"));
  const previousPath = process.env.PATH;
  const previousFetch = globalThis.fetch;
  try {
    const dockerLog = join(directory, "docker.log");
    const dockerPath = join(directory, "docker");
    await writeFile(dockerPath, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$FAKE_DOCKER_LOG\"\ncase \"$1\" in\n  port) printf '127.0.0.1:4096\\n' ;;\n  inspect) printf 'running\\n' ;;\nesac\n");
    await chmod(dockerPath, 0o755);
    await writeFile(dockerLog, "");
    await writeFile(join(directory, "runtime-manifest.json"), JSON.stringify({ manifestHash: "fake-manifest" }));

    process.env.PATH = "/definitely-missing-translucid-path";
    await assert.rejects(new LocalDockerRuntime().start(runtimeInput(directory)), /LOCAL_DOCKER_CLI_UNAVAILABLE|Docker CLI/);

    process.env.PATH = directory;
    process.env.FAKE_DOCKER_LOG = dockerLog;
    globalThis.fetch = async () => new Response("ready", { status: 200 });
    const runtime = new LocalDockerRuntime();
    const handle = await runtime.start(runtimeInput(directory));
    assert.equal(handle.kind, "LOCAL");
    await runtime.stop(handle);
    assert.match(await readFile(dockerLog, "utf8"), /^build --pull --tag translucid-investigator:1\.18\.18/m);
  } finally {
    globalThis.fetch = previousFetch;
    process.env.PATH = previousPath;
    delete process.env.FAKE_DOCKER_LOG;
    await rm(directory, { recursive: true, force: true });
  }
});
