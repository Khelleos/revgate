import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { findRepoRoot, gitErrorMessage, hasHead, isGitRepo, repoRoot } from "../../src/git/exec.js";
import { createRepo } from "../helpers/repo.js";
import { repoRoot as projectRoot, walk } from "../helpers/tree.js";

const SRC = path.join(projectRoot, "src");

/** Every `.ts` file under `src/`, as `[srcRelativePath, contents]` pairs. */
async function srcFiles(): Promise<Array<[string, string]>> {
  const rels = await walk(SRC, ".ts", SRC);
  return Promise.all(
    rels.map(async (rel): Promise<[string, string]> => [
      rel,
      await readFile(path.join(SRC, rel), "utf8"),
    ]),
  );
}

test("exec: git() is the only place the project spawns git", async () => {
  // HARDENED_CONFIG and `--no-ext-diff` live on git()/gitDiff(). A call site that
  // reaches execFile directly inherits the reviewer's own gitconfig, which
  // renames or silently drops files from the review.
  for (const [rel, source] of await srcFiles()) {
    const spawnsGit = /execFile(?:Async|Sync)?\(\s*["'`]git["'`]/.test(source);
    assert.ok(
      !spawnsGit || rel === "git/exec.ts",
      `${rel} spawns git directly; it must go through src/git/exec.ts`,
    );
  }
});

test("exec: the raw git() and gitDiff() runners stay inside the src/git package", async () => {
  // The rule above cannot be side-stepped by importing the raw runner and
  // calling it from elsewhere. `findRepoRoot` and the other wrappers are fair
  // game outside the package — they already carry HARDENED_CONFIG with them.
  const importClause = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["'][^"']*git\/exec\.js["']/g;
  // A namespace or dynamic import hands over every export at once, so neither
  // form can be inspected name by name: outside the package both are refused.
  const opaqueImport =
    /(?:import\s*\*\s*as\s+\w+\s*from|import\s*\(|export\s*\*\s*from)\s*\(?\s*["'][^"']*git\/exec\.js["']/;
  for (const [rel, source] of await srcFiles()) {
    if (rel.startsWith("git/")) continue;
    assert.ok(
      !opaqueImport.test(source),
      `${rel} takes git/exec.js whole; import the named wrappers instead`,
    );
    for (const [, names] of source.matchAll(importClause)) {
      const imported = names.split(",").map((n) => n.trim().split(/\s+as\s+/)[0].trim());
      for (const name of imported) {
        assert.ok(
          name !== "git" && name !== "gitDiff",
          `${rel} imports ${name}() from git/exec.js; only the src/git package may`,
        );
      }
    }
  }
});

test("hasHead / isGitRepo: report what a fresh and a committed repo really are", async (t) => {
  const empty = await createRepo();
  t.after(() => empty.cleanup());
  assert.equal(await isGitRepo(empty.dir), true);
  assert.equal(await hasHead(empty.dir), false, "a repo with no commits has no HEAD");

  const withCommit = await createRepo({ "a.txt": "one\n" });
  t.after(() => withCommit.cleanup());
  assert.equal(await hasHead(withCommit.dir), true);

  // A directory that is not a work tree at all.
  await empty.cleanup();
  assert.equal(await isGitRepo(empty.dir), false);
});

test("findRepoRoot / repoRoot: resolve the toplevel from a subdirectory", async (t) => {
  const repo = await createRepo({ "sub/a.txt": "one\n" });
  t.after(() => repo.cleanup());
  const sub = path.join(repo.dir, "sub");

  // The temp dir may be a symlinked path (/var vs /private/var on macOS), so
  // compare basenames rather than the absolute strings.
  const root = await findRepoRoot(sub);
  assert.ok(root, "the toplevel did not resolve from a subdirectory");
  assert.equal(path.basename(root), path.basename(repo.dir));
  assert.equal(await repoRoot(sub), root);

  // Outside a work tree the two forms disagree on purpose: findRepoRoot says
  // "not a repo", repoRoot falls back to somewhere it can still run.
  await repo.cleanup();
  assert.equal(await findRepoRoot(repo.dir), null);
  assert.equal(await repoRoot(repo.dir), repo.dir);
});

test("gitErrorMessage: prefers git's own fatal line over execFile's argv echo", () => {
  const err = {
    message: "Command failed: git diff --no-ext-diff --no-color nope --",
    stderr: "\nfatal: bad revision 'nope'\n",
  };
  assert.equal(gitErrorMessage(err, "could not diff"), "could not diff: fatal: bad revision 'nope'");
  // No stderr at all: the caller's own wording is what the reader gets.
  assert.equal(gitErrorMessage(new Error("boom"), "could not diff"), "could not diff");
  assert.equal(gitErrorMessage(null, "could not diff"), "could not diff");
  assert.equal(gitErrorMessage({ stderr: "   \n\n" }, "could not diff"), "could not diff");
});
