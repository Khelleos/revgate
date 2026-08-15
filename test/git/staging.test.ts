import assert from "node:assert/strict";
import { rename } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { getStageStates, setStaged } from "../../src/git/staging.js";
import { createRepo } from "../helpers/repo.js";
import { withHostileGitConfig } from "../helpers/scope.js";

test("getStageStates: distinguishes staged, partial, untracked and unstaged", async (t) => {
  const repo = await createRepo({ "staged.txt": "one\n", "partial.txt": "one\n", "dirty.txt": "one\n" });
  t.after(() => repo.cleanup());

  await repo.write("staged.txt", "two\n");
  await repo.git("add", "--", "staged.txt");

  await repo.write("partial.txt", "two\n");
  await repo.git("add", "--", "partial.txt");
  await repo.write("partial.txt", "three\n"); // staged, then diverged again

  await repo.write("dirty.txt", "two\n"); // never staged
  await repo.write("new.txt", "brand new\n"); // untracked

  const states = await getStageStates(repo.dir);
  assert.equal(states["staged.txt"], "yes");
  assert.equal(states["partial.txt"], "partial");
  assert.equal(states["dirty.txt"], "no");
  assert.equal(states["new.txt"], "no");
});

test("getStageStates: a path named __proto__ is a key like any other", async (t) => {
  // On a plain object `states["__proto__"] = …` is swallowed and the read hands
  // back Object.prototype, so the unmerged guard in the stage routes would
  // never fire for such a path and `git reset` would drop its conflict stages.
  const repo = await createRepo({ "__proto__": "one\n", "toString": "one\n" });
  t.after(() => repo.cleanup());

  await repo.write("__proto__", "two\n");
  await repo.git("add", "--", "__proto__");
  await repo.write("toString", "two\n");

  const states = await getStageStates(repo.dir);
  assert.equal(states["__proto__"], "yes");
  assert.equal(states["toString"], "no");
  assert.equal(Object.getPrototypeOf(states), null, "the state map must carry no prototype");
  assert.equal(states["constructor"], undefined, "an unchanged path must have no state");
});

test("getStageStates: a global status.showUntrackedFiles=no still reports untracked files", async (t) => {
  const repo = await createRepo({ "root.txt": "a\n" });
  t.after(() => repo.cleanup());
  await repo.write("fresh.txt", "new\n");

  await withHostileGitConfig(repo, async () => {
    const states = await getStageStates(repo.dir);
    assert.equal(states["fresh.txt"], "no");
  });
});

test("getStageStates: a conflicted path is unmerged, not partially staged", async (t) => {
  // Both status columns are non-blank on a conflict, so `UU` used to classify as
  // "partial" — an indeterminate checkbox whose unstage direction runs
  // `git reset -- <path>`. That drops index stages 1/2/3: status flips to ` M`
  // while MERGE_HEAD and the conflict markers remain, so the conflict looks
  // resolved and the next commit records the markers as the resolution.
  const repo = await createRepo({ "a.txt": "base\n", "clean.txt": "one\n" });
  t.after(() => repo.cleanup());

  await repo.git("checkout", "-b", "other");
  await repo.write("a.txt", "theirs\n");
  await repo.commit("theirs");
  await repo.git("checkout", "main");
  await repo.write("a.txt", "ours\n");
  await repo.commit("ours");
  await assert.rejects(repo.git("merge", "other"), "the merge was supposed to conflict");

  await repo.write("clean.txt", "two\n");
  await repo.git("add", "--", "clean.txt");

  const states = await getStageStates(repo.dir);
  assert.equal(states["a.txt"], "unmerged");
  // A real staged file alongside the conflict is unaffected.
  assert.equal(states["clean.txt"], "yes");
});

test("getStageStates: an add/add conflict is unmerged, not partially staged", async (t) => {
  // The `UU` case above is the only conflict most reviews ever hit, but git
  // reports both-added as `AA` and both-deleted as `DD` — neither column is `U`.
  // Without the extra clauses in isUnmerged both columns are simply non-blank,
  // so the path classifies as "partial": an indeterminate checkbox whose unstage
  // direction runs `git reset -- <path>` and drops conflict stages 1/2/3, leaving
  // the markers on disk to be committed as the resolution.
  const repo = await createRepo({ "base.txt": "base\n" });
  t.after(() => repo.cleanup());

  await repo.git("checkout", "-b", "other");
  await repo.write("added.txt", "theirs\n");
  await repo.commit("theirs add");
  await repo.git("checkout", "main");
  await repo.write("added.txt", "ours\n");
  await repo.commit("ours add");
  await assert.rejects(repo.git("merge", "other"), "the merge was supposed to conflict");

  assert.match(await repo.git("status", "--porcelain=v1"), /^AA /m, "not an add/add conflict");
  const states = await getStageStates(repo.dir);
  assert.equal(states["added.txt"], "unmerged");
});

test("getStageStates: an unreadable repository degrades to no states, not a crash", async (t) => {
  // reviewDiff calls this after collectDiff, so a git failure here must not take
  // down a review that already has its diff — every file just shows an unchecked
  // Staged toggle.
  const repo = await createRepo();
  t.after(() => repo.cleanup());
  await repo.cleanup(); // git cannot run here any more

  assert.deepEqual(Object.keys(await getStageStates(repo.dir)), []);
});

test("getStageStates: a staged rename does not shift the following records", async (t) => {
  // Rename records carry the original path in an extra NUL field. Skipping it
  // wrongly would key every later file's state to the wrong path.
  const repo = await createRepo({ "old.txt": "one\n", "zzz.txt": "one\n" });
  t.after(() => repo.cleanup());

  await repo.git("mv", "old.txt", "new.txt");
  await repo.write("zzz.txt", "two\n");

  const states = await getStageStates(repo.dir);
  assert.equal(states["new.txt"], "yes", "the renamed file lost its state");
  assert.equal(states["zzz.txt"], "no", "a later file inherited the rename's state");
  assert.equal(states["old.txt"], undefined);
});

test("getStageStates: a working-tree rename does not synthesize a phantom path", async (t) => {
  // git reports a rename it detects in the working tree as ` R new` — the R is in
  // the Y column, not X — and that record carries its origin path in the same extra
  // NUL field. Testing only X left the origin token to be parsed as a record of its
  // own, keying a state to `<origin>.slice(3)`: here `ab/zz.txt` becomes `zz.txt`,
  // a real file whose genuine state the phantom then overwrote (git sorts by the
  // new path, so `zzz.txt` lands after `zz.txt`).
  const repo = await createRepo({ "ab/zz.txt": "one\n", "zz.txt": "one\n" });
  t.after(() => repo.cleanup());

  await rename(path.join(repo.dir, "ab/zz.txt"), path.join(repo.dir, "zzz.txt"));
  await repo.git("add", "-N", "--", "zzz.txt"); // intent-to-add: git now sees a rename

  const states = await getStageStates(repo.dir);
  await repo.write("zz.txt", "two\n");
  await repo.git("add", "--", "zz.txt");
  const after = await getStageStates(repo.dir);

  assert.equal(states["zz.txt"], undefined, "an unchanged file must not gain a state");
  assert.equal(after["zz.txt"], "yes", "the phantom overwrote a fully staged file's state");
});

test("setStaged: stages a root-relative path when the cwd is a subdirectory", async (t) => {
  const repo = await createRepo({ "sub/a.txt": "one\n" });
  t.after(() => repo.cleanup());
  await repo.write("sub/a.txt", "one\ntwo\n");

  const states = await setStaged(path.join(repo.dir, "sub"), "sub/a.txt", true);
  assert.equal(states["sub/a.txt"], "yes");
});

test("setStaged: a git failure rejects instead of reporting the unchanged states", async (t) => {
  // Swallowing it made /api/stage answer 200 with the states it failed to
  // change, so the page could not tell "git refused" from "already in that
  // state" — the checkbox just snapped back with nothing to explain why.
  const repo = await createRepo({ "a.txt": "one\n" });
  t.after(() => repo.cleanup());

  await assert.rejects(
    setStaged(repo.dir, "no-such-file.txt", true),
    (err: unknown) =>
      err instanceof Error &&
      /could not stage no-such-file\.txt/.test(err.message) &&
      // The reason git gave, not execFile's "Command failed: git add …" wrapper.
      /pathspec|did not match/i.test(err.message),
  );
});
