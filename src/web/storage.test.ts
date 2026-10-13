import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directoryBytes } from "./storage.ts";

test("case storage accounting counts nested files without following symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "tracedog-storage-"));
  try {
    await mkdir(join(root, "sources"));
    await writeFile(join(root, "input.txt"), "abcd");
    await writeFile(join(root, "sources", "source.txt"), "xyz");
    await symlink(root, join(root, "loop"));
    assert.equal(await directoryBytes(root), 7);
  } finally { await rm(root, { recursive: true, force: true }); }
});
