import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root, resolved from this helper's own location. */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every file under `dir` ending in `ext`, as POSIX paths relative to `from`. */
export async function walk(dir: string, ext: string, from = repoRoot): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full, ext, from)));
    else if (entry.name.endsWith(ext)) found.push(path.relative(from, full).replace(/\\/g, "/"));
  }
  return found.sort();
}
