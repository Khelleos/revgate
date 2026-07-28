/**
 * Mirror `.github/skills/` into `copilot-plugin/skills/`.
 *
 * Copilot reads skills from two places: `.github/skills/` for a repo checkout,
 * and the plugin's own `skills/` directory once it is installed through
 * `/plugin`. Both must ship the same text, so `.github/skills/` is the single
 * source of truth and this script regenerates the packaged copy from it.
 *
 *   npm run sync:skills            # rewrite the packaged copy
 *   npm run sync:skills -- --check # exit 1 if it is out of date (CI / test)
 *
 * `test/plugin.test.ts` byte-compares the two trees, so drift fails the suite.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repoRoot, ".github", "skills");
const dest = path.join(repoRoot, "copilot-plugin", "skills");

const check = process.argv.slice(2).includes("--check");

/** Every path under `dir`, relative and slash-separated, sorted. */
async function walk(dir: string, prefix = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await walk(path.join(dir, entry.name), rel)));
    else found.push(rel);
  }
  return found;
}

const sourceFiles = await walk(source);
if (sourceFiles.length === 0) {
  console.error(`sync:skills: no skills found under ${path.relative(repoRoot, source)}`);
  process.exit(1);
}

const stale: string[] = [];
const written: string[] = [];

for (const rel of sourceFiles) {
  // Read as bytes, not text: the two trees must be byte-identical, so no
  // encoding or line-ending round-trip may happen in between.
  const bytes = await readFile(path.join(source, rel));
  const target = path.join(dest, rel);

  let current: Buffer | null = null;
  try {
    current = await readFile(target);
  } catch {
    // Missing — treated as stale below.
  }
  if (current && current.equals(bytes)) continue;

  stale.push(rel);
  if (check) continue;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  written.push(rel);
}

// Anything the source no longer has must not linger in the package.
const extra = (await walk(dest)).filter((rel) => !sourceFiles.includes(rel));
for (const rel of extra) {
  stale.push(rel);
  if (check) continue;
  await rm(path.join(dest, rel), { force: true });
}

const relDest = path.relative(repoRoot, dest).replace(/\\/g, "/");
if (check) {
  if (stale.length > 0) {
    console.error(`sync:skills: ${relDest} is out of date (${stale.join(", ")}) — run \`npm run sync:skills\``);
    process.exit(1);
  }
  console.error(`sync:skills: ${relDest} is up to date (${sourceFiles.length} files)`);
} else {
  const changed = written.length + extra.length;
  console.error(
    changed === 0
      ? `sync:skills: ${relDest} already up to date (${sourceFiles.length} files)`
      : `sync:skills: updated ${relDest} (${written.length} written, ${extra.length} removed)`,
  );
}
