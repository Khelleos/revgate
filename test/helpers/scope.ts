import path from "node:path";
import { writeFile } from "node:fs/promises";
import { parseUnifiedDiff } from "../../src/review/diff.js";
import { collectDiff } from "../../src/git/collect.js";
import { filterFiles, type DiffScope } from "../../src/git/scope.js";
import type { TempRepo } from "./repo.js";

/** Build a scope with the boilerplate empty filter arrays filled in. */
export function scope(partial: Partial<DiffScope> & Pick<DiffScope, "kind">): DiffScope {
  return { refs: [], include: [], exclude: [], ...partial };
}

/** The paths a scope reports, sorted so assertions don't depend on git's order. */
export async function pathsFor(dir: string, s: DiffScope): Promise<string[]> {
  const repo = await collectDiff(dir, s);
  return filterFiles(parseUnifiedDiff(repo.unified), s)
    .map((f) => f.path)
    .sort();
}

/** Make a file that isn't in any commit, to prove ref scopes ignore it. */
export async function addUntracked(repo: TempRepo): Promise<void> {
  await repo.write("untracked.txt", "loose\n");
}

/**
 * Run `fn` with a hostile `~/.gitconfig` in force for every git process spawned.
 * Each setting is a legitimate preference that corrupts a review; see agents.md.
 */
export async function withHostileGitConfig(
  repo: TempRepo,
  fn: () => Promise<void>,
): Promise<void> {
  // Inside .git: in the tree it would join the diff under test as an untracked file.
  const file = path.join(repo.dir, ".git", "hostile-gitconfig");
  await writeFile(
    file,
    // srcPrefix/dstPrefix are what `+++ b/<path>` cannot rescue; `external` is
    // difftastic, the one `-c` cannot switch off.
    "[diff]\n\trelative = true\n\tmnemonicPrefix = true\n\tnoprefix = true\n" +
      "\tsrcPrefix = X/\n\tdstPrefix = Y/\n\texternal = echo EXTERNAL\n" +
      "[status]\n\tshowUntrackedFiles = no\n",
    "utf8",
  );
  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = file;
  try {
    await fn();
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
  }
}
