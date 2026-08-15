import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseUnifiedDiff } from "../../src/review/diff.js";
import { collectDiff } from "../../src/git/collect.js";
import { ScopeError } from "../../src/git/scope.js";
import { getStageStates, setStaged } from "../../src/git/staging.js";
import { createRepo, type TempRepo } from "../helpers/repo.js";
import { addUntracked, pathsFor, scope, withHostileGitConfig } from "../helpers/scope.js";

test("collectDiff: reports a non-repo and still labels the scope", async (t) => {
  const repo = await createRepo();
  t.after(() => repo.cleanup());
  // Deleted out from under us: git cannot run here, so this is the not-a-repo path.
  await repo.cleanup();

  const result = await collectDiff(repo.dir, scope({ kind: "ref", refs: ["main"] }));
  assert.equal(result.isRepo, false);
  assert.equal(result.unified, "");
  assert.equal(result.branch, null);
  assert.equal(result.scopeLabel, "main vs working tree");
});

test("collectDiff: worktree scope covers staged, unstaged and untracked", async (t) => {
  const repo = await createRepo({ "src/a.ts": "a1\n", "docs/b.md": "b1\n" });
  t.after(() => repo.cleanup());

  await repo.write("src/a.ts", "a2\n");
  await repo.git("add", "src/a.ts"); // staged
  await repo.write("docs/b.md", "b2\n"); // unstaged
  await addUntracked(repo);

  const result = await collectDiff(repo.dir, scope({ kind: "worktree" }));
  assert.equal(result.isRepo, true);
  assert.equal(result.branch, "main");
  assert.equal(result.scopeLabel, "working tree vs HEAD");
  assert.deepEqual(result.untracked, ["untracked.txt"]);
  assert.deepEqual(
    parseUnifiedDiff(result.unified).map((f) => f.path).sort(),
    ["docs/b.md", "src/a.ts", "untracked.txt"],
  );
});

test("collectDiff: staged scope sees only the index, never untracked files", async (t) => {
  const repo = await createRepo({ "src/a.ts": "a1\n", "docs/b.md": "b1\n" });
  t.after(() => repo.cleanup());

  await repo.write("src/a.ts", "a2\n");
  await repo.git("add", "src/a.ts");
  await repo.write("docs/b.md", "b2\n"); // left unstaged
  await addUntracked(repo);

  const result = await collectDiff(repo.dir, scope({ kind: "staged" }));
  assert.equal(result.scopeLabel, "staged changes");
  assert.deepEqual(result.untracked, []);
  assert.deepEqual(parseUnifiedDiff(result.unified).map((f) => f.path), ["src/a.ts"]);
});

test("collectDiff: single ref compares that ref against the working tree", async (t) => {
  const repo = await createRepo({ "src/a.ts": "a1\n" });
  t.after(() => repo.cleanup());

  await repo.write("src/b.ts", "b1\n");
  await repo.commit("second");
  await repo.write("src/a.ts", "a2\n"); // uncommitted, still in the working tree

  const result = await collectDiff(repo.dir, scope({ kind: "ref", refs: ["HEAD~1"] }));
  assert.equal(result.scopeLabel, "HEAD~1 vs working tree");
  assert.deepEqual(
    parseUnifiedDiff(result.unified).map((f) => f.path).sort(),
    ["src/a.ts", "src/b.ts"],
  );
});

test("collectDiff: ref scope never synthesizes untracked files", async (t) => {
  const repo = await createRepo({ "src/a.ts": "a1\n" });
  t.after(() => repo.cleanup());

  await repo.write("src/b.ts", "b1\n");
  await repo.commit("second");
  await addUntracked(repo);

  const result = await collectDiff(repo.dir, scope({ kind: "ref", refs: ["HEAD~1"] }));
  assert.deepEqual(result.untracked, []);
  assert.deepEqual(parseUnifiedDiff(result.unified).map((f) => f.path), ["src/b.ts"]);

  // …but the same file DOES show up when the scope is the working tree.
  const worktree = await collectDiff(repo.dir, scope({ kind: "worktree" }));
  assert.ok(parseUnifiedDiff(worktree.unified).some((f) => f.path === "untracked.txt"));
});

/** main and feature diverge after a shared base, so `..` and `...` differ. */
async function divergedRepo(): Promise<TempRepo> {
  const repo = await createRepo({ "src/a.ts": "a1\n" });
  await repo.git("checkout", "-b", "feature");
  await repo.write("src/feature.ts", "f1\n");
  await repo.commit("feature work");
  await repo.git("checkout", "main");
  await repo.write("src/main.ts", "m1\n");
  await repo.commit("main work");
  return repo;
}

test("collectDiff: two refs diff the endpoints against each other", async (t) => {
  const repo = await divergedRepo();
  t.after(() => repo.cleanup());
  await addUntracked(repo);

  const result = await collectDiff(
    repo.dir,
    scope({ kind: "range", refs: ["main", "feature"], dots: ".." }),
  );
  assert.equal(result.scopeLabel, "main..feature");
  assert.deepEqual(result.untracked, []);
  // feature relative to main: it has src/feature.ts and lacks src/main.ts.
  const files = parseUnifiedDiff(result.unified);
  assert.deepEqual(files.map((f) => f.path).sort(), ["src/feature.ts", "src/main.ts"]);
  assert.equal(files.find((f) => f.path === "src/feature.ts")!.isNew, true);
  assert.equal(files.find((f) => f.path === "src/main.ts")!.isDeleted, true);
});

test("collectDiff: a dotted three-dot range diffs from the merge base", async (t) => {
  const repo = await divergedRepo();
  t.after(() => repo.cleanup());

  const result = await collectDiff(
    repo.dir,
    scope({ kind: "range", refs: ["main", "feature"], dots: "..." }),
  );
  assert.equal(result.scopeLabel, "main...feature");
  // From the merge base, only feature's own commit shows — main's is not "removed".
  assert.deepEqual(parseUnifiedDiff(result.unified).map((f) => f.path), ["src/feature.ts"]);
});

test("collectDiff: a range with no merge base is a ScopeError, not a crash", async (t) => {
  // Both refs resolve, so verifyRef passes; it is the *combination* git rejects.
  // That is bad usage (exit 2), not the unexpected-error path (exit 1).
  const repo = await createRepo({ "a.txt": "one\n" });
  t.after(() => repo.cleanup());
  const first = (await repo.git("rev-parse", "HEAD")).trim();

  // An orphan branch shares no history with main.
  await repo.git("checkout", "--orphan", "other");
  await repo.git("rm", "-rf", "--cached", ".");
  await repo.write("b.txt", "two\n");
  await repo.commit("orphan");
  const orphan = (await repo.git("rev-parse", "HEAD")).trim();

  await assert.rejects(
    collectDiff(repo.dir, scope({ kind: "range", refs: [first, orphan], dots: "..." })),
    (err: unknown) => err instanceof ScopeError && /could not diff/.test((err as Error).message),
  );
});

test("collectDiff: a repository with no commits still reports its staged files", async (t) => {
  // `git init` + `git add .` + a first agent turn is the very first run a new
  // user hits, and HEAD does not resolve yet.
  const repo = await createRepo();
  t.after(() => repo.cleanup());
  await repo.write("first.txt", "hello\n");
  await repo.git("add", "-A");

  const out = await collectDiff(repo.dir, scope({ kind: "worktree" }));
  assert.equal(out.isRepo, true);
  const files = parseUnifiedDiff(out.unified);
  assert.deepEqual(files.map((f) => f.path).sort(), ["first.txt"]);
});

test("collectDiff: untracked files are repo-root-relative when run from a subdirectory", async (t) => {
  // `git ls-files --others` prints cwd-relative paths and only walks the cwd
  // subtree, while `git diff` is root-relative from anywhere. Reviewing from a
  // subdirectory used to drop untracked files outside it and put the rest in a
  // different namespace from the tracked diff, breaking filterFiles and the
  // getStageStates lookup.
  const repo = await createRepo({ "sub/tracked.txt": "one\n" });
  t.after(() => repo.cleanup());
  await repo.write("sub/tracked.txt", "one\ntwo\n");
  await repo.write("sub/nested.txt", "nested\n");
  await repo.write("root.txt", "root\n");

  const result = await collectDiff(path.join(repo.dir, "sub"), scope({ kind: "worktree" }));
  assert.deepEqual([...result.untracked].sort(), ["root.txt", "sub/nested.txt"]);
  assert.deepEqual(
    parseUnifiedDiff(result.unified)
      .map((f) => f.path)
      .sort(),
    ["root.txt", "sub/nested.txt", "sub/tracked.txt"],
  );
});

test("collectDiff: a path staged for deletion but still on disk is reported once", async (t) => {
  // `git rm --cached` is the one command that puts a path in BOTH lists: the
  // index has the deletion (so `diff HEAD` reports it) while the file is still on
  // disk and now untracked (so `ls-files --others` reports it too). Two DiffFiles
  // with the same path double-count the file, render two indistinguishable
  // sidebar rows, list every remark on it twice, and make the new-side comment
  // lookup resolve against the deleted entry — so it quotes back no code at all.
  const repo = await createRepo({ "x.txt": "one\ntwo\n" });
  t.after(() => repo.cleanup());
  await repo.git("rm", "--cached", "x.txt");

  const diff = await collectDiff(repo.dir, scope({ kind: "worktree" }));
  const files = parseUnifiedDiff(diff.unified).filter((f) => f.path === "x.txt");
  assert.equal(files.length, 1, "one entry per path");
  assert.equal(files[0].isDeleted, true, "the tracked view against HEAD wins");
  // The reported untracked list has to agree with the diff it produced.
  assert.deepEqual(diff.untracked, []);

  // ...and the staged deletion is not buried by the `??` record git prints after
  // it: reporting "no" here makes the UI offer a stage toggle whose `git add`
  // silently reverts the deletion.
  const states = await getStageStates(repo.dir);
  assert.equal(states["x.txt"], "yes");
});

test("collectDiff: an ordinary untracked file is still synthesized", async (t) => {
  // The dedupe above must key on the path being in the tracked diff, not on
  // "there is a tracked diff at all" — untracked files are the reason the
  // worktree scope synthesizes anything.
  const repo = await createRepo({ "a.txt": "one\n" });
  t.after(() => repo.cleanup());
  await repo.write("a.txt", "one\ntwo\n");
  await repo.write("new.txt", "fresh\n");

  assert.deepEqual(await pathsFor(repo.dir, scope({ kind: "worktree" })), ["a.txt", "new.txt"]);
});

// --- inherited git config ---------------------------------------------------

test("collectDiff: the reviewer's own diff.* config cannot shrink or rename the review", async (t) => {
  // A binary file has no `---`/`+++` lines, so its path can only be recovered
  // from the `diff --git a/… b/…` header. It is the only case that actually
  // depends on the prefix pins: a text file whose header prefix is mangled is
  // still rescued by `+++`, which is why this suite used to pass with
  // noprefix/srcPrefix/dstPrefix removed from HARDENED_CONFIG.
  const repo = await createRepo({ "root.txt": "a\n", "src/deep/a.ts": "b\n" });
  t.after(() => repo.cleanup());
  await writeFile(path.join(repo.dir, "src", "deep", "logo.png"), Buffer.from([0x89, 0x50, 0x00, 1]));
  await repo.commit("add a binary file");

  await repo.write("root.txt", "a2\n");
  await repo.write("src/deep/a.ts", "b2\n");
  await writeFile(path.join(repo.dir, "src", "deep", "logo.png"), Buffer.from([0x89, 0x50, 0x00, 2, 3]));

  await withHostileGitConfig(repo, async () => {
    // From a SUBDIRECTORY, which is how an agent invokes the CLI, and the case
    // diff.relative silently truncates: root.txt sits outside src/deep.
    const sub = path.join(repo.dir, "src", "deep");
    assert.deepEqual(await pathsFor(sub, scope({ kind: "worktree" })), [
      "root.txt",
      "src/deep/a.ts",
      "src/deep/logo.png",
    ]);
    // Root-relative paths mean the -I prefix filter still resolves.
    assert.deepEqual(await pathsFor(sub, scope({ kind: "worktree", include: ["src"] })), [
      "src/deep/a.ts",
      "src/deep/logo.png",
    ]);
  });
});

test("collectDiff: an external diff driver cannot empty the review", async (t) => {
  // `diff.external`/`GIT_EXTERNAL_DIFF` (difftastic, delta, …) replaces git's
  // unified output with the driver's, and git still exits 0 — so without
  // `--no-ext-diff` parseUnifiedDiff returns [], reviewDiff takes the "nothing
  // to review" branch, and the gate reports APPROVED at exit 0 over a diff
  // nobody saw. It is the one setting `-c` cannot switch off (`-c diff.external=`
  // makes git try to spawn the empty string and die), so only the flag works.
  const repo = await createRepo({ "a.txt": "one\n" });
  t.after(() => repo.cleanup());
  await repo.write("a.txt", "one\ntwo\n");

  await withHostileGitConfig(repo, async () => {
    const result = await collectDiff(repo.dir, scope({ kind: "worktree" }));
    assert.doesNotMatch(result.unified, /EXTERNAL/, "the external driver's output reached the review");
    const files = parseUnifiedDiff(result.unified);
    assert.deepEqual(files.map((f) => f.path), ["a.txt"]);
    assert.equal(files[0].additions, 1, "the hunk body was lost");
  });

  // The same setting reaching us through the environment instead of a config
  // file, which is how a shell wrapper or an editor integration exports it.
  const saved = process.env.GIT_EXTERNAL_DIFF;
  process.env.GIT_EXTERNAL_DIFF = "echo EXTERNAL";
  try {
    const result = await collectDiff(repo.dir, scope({ kind: "worktree" }));
    assert.deepEqual(parseUnifiedDiff(result.unified).map((f) => f.path), ["a.txt"]);
  } finally {
    if (saved === undefined) delete process.env.GIT_EXTERNAL_DIFF;
    else process.env.GIT_EXTERNAL_DIFF = saved;
  }
});

test("collectDiff: a non-ASCII path survives as the real name on disk", async (t) => {
  // git C-quotes any path with a non-ASCII byte unless core.quotePath=false, and
  // the quoted form (`"caf\303\251.txt"`) resolves to nothing: filterFiles would
  // drop the file from every -I/-X review, the stage lookup would never match
  // the raw `status -z` name, and the annotation would point at no file at all.
  const repo = await createRepo({ "café.txt": "one\n" });
  t.after(() => repo.cleanup());
  await repo.write("café.txt", "one\ntwo\n");
  await repo.write("src/日本.md", "new\n");

  assert.deepEqual(await pathsFor(repo.dir, scope({ kind: "worktree" })), [
    "café.txt",
    "src/日本.md",
  ]);

  // The two consumers that would silently mislead if the name were mangled.
  // Prefixes match at path boundaries, so the filter is the whole file name here
  // (`café` alone is a mid-name prefix and matches nothing).
  assert.deepEqual(await pathsFor(repo.dir, scope({ kind: "worktree", include: ["café.txt"] })), [
    "café.txt",
  ]);
  assert.deepEqual(await pathsFor(repo.dir, scope({ kind: "worktree", include: ["src"] })), [
    "src/日本.md",
  ]);
  const states = await getStageStates(repo.dir);
  assert.equal(states["café.txt"], "no");
  assert.equal((await setStaged(repo.dir, "café.txt", true))["café.txt"], "yes");
});
