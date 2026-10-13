import { readdir, stat, statfs } from "node:fs/promises";
import { join } from "node:path";

export async function directoryBytes(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(child);
    else if (entry.isFile()) total += (await stat(child).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

export async function hasCaseSpace(root: string): Promise<boolean> {
  const space = await statfs(root);
  return space.bavail * space.bsize >= 256 * 1024 * 1024 && await directoryBytes(root) < 700 * 1024 * 1024;
}
