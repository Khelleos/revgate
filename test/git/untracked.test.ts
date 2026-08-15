import assert from "node:assert/strict";
import { chmod, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { parseUnifiedDiff } from "../../src/review/diff.js";
import { collectDiff } from "../../src/git/collect.js";
import { looksBinary } from "../../src/git/untracked.js";
import { createRepo } from "../helpers/repo.js";
import { scope } from "../helpers/scope.js";

/**
 * Create a symlink, or skip the test where the platform will not allow one.
 * Windows needs Developer Mode or an elevated shell for a file symlink, and a
 * contributor without either should not see a red suite.
 */
async function symlinkOrSkip(t: TestContext, target: string, linkPath: string): Promise<boolean> {
  try {
    await symlink(target, linkPath);
    return true;
  } catch (err) {
    t.skip(`symlinks unavailable on this platform: ${(err as Error).message}`);
    return false;
  }
}

test("looksBinary: a NUL byte in the first 8KB marks the buffer binary", () => {
  assert.equal(looksBinary(Buffer.from("plain text\n", "utf8")), false);
  assert.equal(looksBinary(Buffer.from([0x89, 0x50, 0x00, 0x01])), true);
  assert.equal(looksBinary(Buffer.alloc(0)), false);
  // Past the 8KB window the heuristic deliberately stops looking, the way git does.
  const late = Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0x00])]);
  assert.equal(looksBinary(late), false);
});

test("collectDiff: an untracked binary file is reported as binary, not as text", async (t) => {
  const repo = await createRepo({ "a.txt": "one\n" });
  t.after(() => repo.cleanup());
  await writeFile(path.join(repo.dir, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));

  const files = parseUnifiedDiff((await collectDiff(repo.dir, scope({ kind: "worktree" }))).unified);
  const png = files.find((f) => f.path === "logo.png");
  assert.ok(png, "the untracked binary never made it into the diff");
  // The UI shows a placeholder for these; misreporting one renders NUL bytes.
  assert.equal(png.isBinary, true);
});

test("collectDiff: an oversized untracked file is listed but not inlined", async (t) => {
  // The tracked diff is bounded by git's own maxBuffer; an untracked file is read
  // by us. Without a cap one stray log or dump is read whole, split into per-line
  // objects, and JSON-serialized to the browser — a memory spike and a UI nobody
  // can scroll. It still has to appear, or a file silently leaves the review.
  const repo = await createRepo({ "a.txt": "one\n" });
  t.after(() => repo.cleanup());
  await writeFile(path.join(repo.dir, "huge.log"), "x".repeat(3 * 1024 * 1024) + "\n");

  const files = parseUnifiedDiff((await collectDiff(repo.dir, scope({ kind: "worktree" }))).unified);
  const huge = files.find((f) => f.path === "huge.log");
  assert.ok(huge, "the oversized file vanished from the review");
  assert.equal(huge.isBinary, true, "shown as unexpanded, the way a binary file is");
  assert.deepEqual(huge.hunks, [], "3MB of content must not be inlined");
});

test("collectDiff: untracked expansion stops at a total byte budget, still listing the rest", async (t) => {
  // The per-file cap does not bound the *set*, and the worktree scope expands every
  // untracked path on every agent turn: an un-gitignored data or dist tree used to
  // be read whole, concatenated, re-split per line, and JSON-serialized — an OOM or
  // a hook that outlives its timeout. One long line per file keeps the parse cheap.
  const repo = await createRepo({ "a.txt": "one\n" });
  t.after(() => repo.cleanup());
  const names = ["d1.log", "d2.log", "d3.log", "d4.log", "d5.log", "d6.log"];
  for (const n of names) await repo.write(n, "x".repeat(1_900_000) + "\n");

  const files = parseUnifiedDiff((await collectDiff(repo.dir, scope({ kind: "worktree" }))).unified);
  assert.deepEqual(
    files.map((f) => f.path).sort(),
    [...names].sort(),
    "every untracked file must still be listed",
  );
  // 8MB of budget at ~1.9MB each: four expand, the remainder is listed unexpanded.
  const expanded = files.filter((f) => f.hunks.length > 0).map((f) => f.path);
  assert.deepEqual(expanded, ["d1.log", "d2.log", "d3.log", "d4.log"]);
  for (const p of ["d5.log", "d6.log"]) {
    const f = files.find((x) => x.path === p);
    assert.ok(f);
    assert.equal(f.isBinary, true, `${p} should be listed the way an unexpanded file is`);
  }
});

test("collectDiff: untracked expansion stops at a file-count budget", async (t) => {
  // A wide tree of small files never reaches the byte total, but still costs a
  // read, a per-line object graph, and a JSON copy per file.
  const repo = await createRepo({ "a.txt": "one\n" });
  t.after(() => repo.cleanup());
  // Zero-padded so `git ls-files` order (lexicographic) is the order asserted.
  const names = Array.from({ length: 305 }, (_, i) => `many/f${String(i).padStart(4, "0")}.txt`);
  for (const n of names) await repo.write(n, "content\n");

  const files = parseUnifiedDiff((await collectDiff(repo.dir, scope({ kind: "worktree" }))).unified);
  assert.equal(files.length, names.length, "every untracked file must still be listed");
  const expanded = files.filter((f) => f.hunks.length > 0).map((f) => f.path);
  assert.equal(expanded.length, 300);
  assert.deepEqual(expanded, names.slice(0, 300));
});

test("collectDiff: an untracked empty file appears with no hunks", async (t) => {
  const repo = await createRepo({ "a.txt": "one\n" });
  t.after(() => repo.cleanup());
  await writeFile(path.join(repo.dir, "empty.txt"), "");

  const files = parseUnifiedDiff((await collectDiff(repo.dir, scope({ kind: "worktree" }))).unified);
  const empty = files.find((f) => f.path === "empty.txt");
  assert.ok(empty, "the empty untracked file was dropped entirely");
  assert.deepEqual(empty.hunks, []);
  assert.equal(empty.isBinary, false);
});

test("collectDiff: an untracked file with no trailing newline keeps its last line", async (t) => {
  const repo = await createRepo({ "a.txt": "one\n" });
  t.after(() => repo.cleanup());
  await writeFile(path.join(repo.dir, "tail.txt"), "first\nsecond");

  const files = parseUnifiedDiff((await collectDiff(repo.dir, scope({ kind: "worktree" }))).unified);
  const tail = files.find((f) => f.path === "tail.txt");
  assert.ok(tail);
  const added = tail.hunks.flatMap((h) => h.lines).filter((l) => l.type === "add");
  assert.deepEqual(added.map((l) => l.content), ["first", "second"]);
});

test("collectDiff: an untracked file with a non-ASCII name is still reviewed", async (t) => {
  // `git ls-files` C-quotes non-ASCII paths ("caf\303\251.txt") unless asked for
  // NUL-terminated output, and a quoted path does not resolve on disk — so the
  // file leaves the diff with only a stderr warning behind it.
  const repo = await createRepo({ "a.txt": "one\n" });
  t.after(() => repo.cleanup());
  await repo.write("café.txt", "crème\n");

  const result = await collectDiff(repo.dir, scope({ kind: "worktree" }));
  assert.deepEqual(result.untracked, ["café.txt"]);
  assert.deepEqual(
    parseUnifiedDiff(result.unified).map((f) => f.path),
    ["café.txt"],
  );
});

test("collectDiff: an untracked symlink is recorded as a link, not as its target's content", async (t) => {
  // `ls-files --others` lists symlinks, and following one is wrong twice over:
  // git stores a symlink as mode 120000 whose whole content is the target path,
  // so dereferencing shows content that is not in the repository at all — and
  // writes it into the markdown archived under ~/.revgate/history. An untracked
  // `config -> ~/.aws/credentials` used to get its secrets inlined into both.
  const repo = await createRepo({ "a.txt": "one\n" });
  t.after(() => repo.cleanup());
  const outside = path.join(repo.dir, "outside-secret.txt");
  await writeFile(outside, "AWS_SECRET_ACCESS_KEY=hunter2\n", "utf8");
  await repo.write(".gitignore", "outside-secret.txt\n");
  await repo.commit("ignore the secret");
  if (!(await symlinkOrSkip(t, outside, path.join(repo.dir, "creds.link")))) return;

  const diff = await collectDiff(repo.dir, scope({ kind: "worktree" }));

  assert.ok(!diff.unified.includes("hunter2"), "the target's content leaked into the diff");
  assert.match(diff.unified, /new file mode 120000/, "a symlink must not be announced as 100644");
  const link = parseUnifiedDiff(diff.unified).find((f) => f.path === "creds.link");
  assert.ok(link, "the untracked symlink left the review entirely");
  // What git itself shows for a new symlink: one added line, the target path.
  const added = link.hunks.flatMap((h) =>
    h.lines.filter((l) => l.type === "add").map((l) => l.content),
  );
  assert.deepEqual(added, [outside]);
});

test("collectDiff: a symlink reporting size 0 still cannot bypass the untracked budget", async (t) => {
  // `stat` follows links, so a link to a FIFO or /dev/zero reported size 0 and
  // passed both the per-file cap and the shared budget — then `readFile` blocked
  // with no writer or grew until OOM, which is the hook outliving its timeout
  // instead of gating the agent. `lstat` sizes the link itself, and a link is
  // never read as a file at all.
  const repo = await createRepo({ "a.txt": "one\n" });
  t.after(() => repo.cleanup());
  const big = path.join(repo.dir, "big.bin");
  await writeFile(big, "x".repeat(3 * 1024 * 1024) + "\n", "utf8");
  await repo.write(".gitignore", "big.bin\n");
  await repo.commit("ignore the payload");
  if (!(await symlinkOrSkip(t, big, path.join(repo.dir, "big.link")))) return;

  const diff = await collectDiff(repo.dir, scope({ kind: "worktree" }));

  // Oversized target, but the link expands to its own tiny content, not the 3MB.
  assert.ok(diff.unified.length < 64 * 1024, "the link's target was inlined");
  const link = parseUnifiedDiff(diff.unified).find((f) => f.path === "big.link");
  assert.ok(link, "the symlink left the review");
  assert.deepEqual(
    link.hunks.flatMap((h) => h.lines.filter((l) => l.type === "add").map((l) => l.content)),
    [big],
  );
});

test("collectDiff: a symlink elided by the file budget is still announced as a symlink", async (t) => {
  // The budget decides whether a path is *expanded*, never what it *is*. The
  // early return on it ran before `lstat`, so past the 300-file ceiling every
  // untracked symlink was headed `new file mode 100644` — the same lie about
  // what the repository would gain on commit that the mode handling exists to
  // prevent, just moved past a threshold nobody reads the code at.
  const repo = await createRepo({ "a.txt": "one\n" });
  t.after(() => repo.cleanup());
  const target = path.join(repo.dir, "outside-secret.txt");
  await writeFile(target, "AWS_SECRET_ACCESS_KEY=hunter2\n", "utf8");
  await repo.write(".gitignore", "outside-secret.txt\n");
  await repo.commit("ignore the secret");

  // `zz.link` sorts last, so the 300-file budget is spent before it is reached.
  const names = Array.from({ length: 305 }, (_, i) => `many/f${String(i).padStart(4, "0")}.txt`);
  for (const n of names) await repo.write(n, "content\n");
  if (!(await symlinkOrSkip(t, target, path.join(repo.dir, "zz.link")))) return;

  const diff = await collectDiff(repo.dir, scope({ kind: "worktree" }));
  assert.ok(!diff.unified.includes("hunter2"), "the target's content leaked into the diff");

  const link = parseUnifiedDiff(diff.unified).find((f) => f.path === "zz.link");
  assert.ok(link, "the elided symlink left the review entirely");
  assert.equal(link.hunks.length, 0, "the link should have been elided, not expanded");
  assert.match(
    diff.unified,
    /diff --git a\/zz\.link b\/zz\.link\nnew file mode 120000\n/,
    "an elided symlink was announced as a regular file",
  );
});

test("collectDiff: a healthy untracked scan does not flag itself as failed", async (t) => {
  // The negative half of the untrackedScanFailed contract: reviewReport turns the
  // flag into SCAN FAILED and exit 2, so a false positive breaks every clean run.
  const repo = await createRepo({ "a.txt": "one\n" });
  t.after(() => repo.cleanup());
  await repo.write("new.txt", "fresh\n");

  const diff = await collectDiff(repo.dir, scope({ kind: "worktree" }));
  assert.deepEqual(diff.untracked, ["new.txt"]);
  assert.ok(!diff.untrackedScanFailed);
  assert.ok(!diff.droppedUntracked);
});

test("collectDiff: an untracked file whose name has a newline is counted, not just warned", async (t) => {
  // Dropping the path is right — everything downstream is line-oriented, and a
  // newline in it would splice phantom `## path:line` records into the report.
  // Dropping it *silently* is not: a tree whose only change is such a file used
  // to review as APPROVED with `files: 0`, and only stderr said otherwise —
  // which is exactly what an agent reading `-o <file>` never sees.
  const repo = await createRepo({ "a.txt": "one\n" });
  t.after(() => repo.cleanup());
  const evil = path.join(repo.dir, "ev\nil.txt");
  try {
    await writeFile(evil, "content\n", "utf8");
  } catch (err) {
    // Windows rejects a newline in a filename outright; there is nothing to test.
    t.skip(`newlines in filenames unavailable on this platform: ${(err as Error).message}`);
    return;
  }

  const diff = await collectDiff(repo.dir, scope({ kind: "worktree" }));
  assert.deepEqual(diff.untracked, [], "the unsafe path must not reach the synthesized diff");
  assert.equal(diff.droppedUntracked, 1, "the drop left no trace on the diff");
});

test("collectDiff: an unreadable untracked file is listed unexpanded, never dropped", async (t) => {
  // untrackedFileDiff's catch lists a file it cannot read without a diff.
  // Returning "" there removed the file from collectDiff's output entirely —
  // the one path where a file silently left the review — and nothing else
  // guards that invariant.
  if (process.platform === "win32") return t.skip("chmod 0o000 does not forbid reads on Windows");
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return t.skip("root reads files regardless of their mode");
  }
  const repo = await createRepo({ "a.txt": "one\n" });
  t.after(() => repo.cleanup());
  await repo.write("locked.txt", "cannot be read\n");
  await chmod(path.join(repo.dir, "locked.txt"), 0o000);

  const diff = await collectDiff(repo.dir, scope({ kind: "worktree" }));
  assert.ok(!diff.untrackedScanFailed, "one unreadable file is not a failed scan");
  assert.ok(!diff.unified.includes("cannot be read"), "unreadable content leaked into the diff");
  const entry = parseUnifiedDiff(diff.unified).find((f) => f.path === "locked.txt");
  assert.ok(entry, "the unreadable file left the review entirely");
  assert.equal(entry.hunks.length, 0, "there is no readable content to expand");
});
