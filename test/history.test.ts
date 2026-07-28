import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import {
  historyRoot,
  renderHistoryDocument,
  repoSegment,
  sanitizeSegment,
  saveHistory,
  timestampName,
} from "../src/history.js";
import { createRepo } from "./helpers/repo.js";
import type { DiffFile, LineComment, ReviewSubmission } from "../src/types.js";

const AT = new Date("2026-07-29T15:30:00.123Z");

const file = (p: string): DiffFile => ({
  oldPath: p,
  newPath: p,
  path: p,
  isNew: false,
  isDeleted: false,
  isRenamed: false,
  isBinary: false,
  additions: 1,
  deletions: 0,
  hunks: [],
});

const comment = (over: Partial<LineComment> = {}): LineComment => ({
  file: "src/app.ts",
  startLine: 2,
  endLine: 2,
  side: "new",
  body: "Use const.",
  ...over,
});

const review = (over: Partial<ReviewSubmission> = {}): ReviewSubmission => ({
  decision: "request_changes",
  summary: "Needs another pass.",
  comments: [comment()],
  ...over,
});

/**
 * A throwaway directory to point --history-dir at.
 *
 * Registered for removal rather than left behind: this file makes a dozen of
 * them per run, most holding written history documents, and an abandoned one is
 * still an abandoned one when it is only 4 KB of the developer's temp directory.
 */
const temps: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "revgate-hist-"));
  temps.push(dir);
  return dir;
}
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

/** Run `fn` with stderr captured, so a warning can be asserted on. */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await fn(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

/** Every file written under `root`, as paths relative to it. */
async function tree(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else out.push(rel);
    }
  };
  await walk(root, "");
  return out.sort();
}

// --- directory resolution --------------------------------------------------

test("historyRoot: --history-dir beats the env var, which beats ~/.revgate", () => {
  const saved = process.env.REVGATE_HISTORY_DIR;
  try {
    delete process.env.REVGATE_HISTORY_DIR;
    assert.equal(historyRoot(), path.join(os.homedir(), ".revgate", "history"));
    assert.equal(historyRoot("   "), path.join(os.homedir(), ".revgate", "history"));

    process.env.REVGATE_HISTORY_DIR = path.join(os.tmpdir(), "from-env");
    assert.equal(historyRoot(), path.join(os.tmpdir(), "from-env"));
    assert.equal(historyRoot(path.join(os.tmpdir(), "from-flag")), path.join(os.tmpdir(), "from-flag"));
  } finally {
    if (saved === undefined) delete process.env.REVGATE_HISTORY_DIR;
    else process.env.REVGATE_HISTORY_DIR = saved;
  }
});

test("historyRoot: a relative directory resolves against the cwd", () => {
  const saved = process.env.REVGATE_HISTORY_DIR;
  try {
    delete process.env.REVGATE_HISTORY_DIR;
    assert.equal(historyRoot("reviews"), path.resolve("reviews"));
  } finally {
    if (saved !== undefined) process.env.REVGATE_HISTORY_DIR = saved;
  }
});

// --- name sanitization -----------------------------------------------------

test("sanitizeSegment: keeps safe names, collapses everything else", () => {
  assert.equal(sanitizeSegment("revgate"), "revgate");
  assert.equal(sanitizeSegment("my.repo-2_x"), "my.repo-2_x");
  assert.equal(sanitizeSegment("my repo"), "my-repo");
  assert.equal(sanitizeSegment("a/b\\c"), "a-b-c");
  assert.equal(sanitizeSegment("weird:*?name"), "weird-name");
  assert.equal(sanitizeSegment("  spaced  "), "spaced");
});

test("sanitizeSegment: a name that could escape the directory cannot", () => {
  assert.equal(sanitizeSegment(".."), "no-repo");
  assert.equal(sanitizeSegment("."), "no-repo");
  assert.equal(sanitizeSegment("../../etc"), "etc");
  assert.equal(sanitizeSegment(""), "no-repo");
  assert.equal(sanitizeSegment("///"), "no-repo");
});

test("timestampName: an ISO stamp with no path-hostile characters", () => {
  assert.equal(timestampName(AT), "2026-07-29T15-30-00-123Z.md");
  assert.doesNotMatch(timestampName(AT), /[:*?"<>|]/);
});

// --- repo name -------------------------------------------------------------

test("repoSegment: the git toplevel basename inside a repo", async (t) => {
  const repo = await createRepo({ "a.txt": "one\n" });
  t.after(() => repo.cleanup());

  const expected = sanitizeSegment(path.basename(await realTop(repo.dir)));
  assert.equal(await repoSegment(repo.dir), expected);
  // A subdirectory still reports the toplevel, not itself.
  await repo.write("nested/b.txt", "two\n");
  assert.equal(await repoSegment(path.join(repo.dir, "nested")), expected);
});

test("repoSegment: no-repo outside a repository", async () => {
  const dir = await tempDir();
  assert.equal(await repoSegment(dir), "no-repo");
});

/** git resolves symlinked temp dirs (macOS /var -> /private/var); follow suit. */
async function realTop(dir: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("git", ["rev-parse", "--show-toplevel"], { cwd: dir });
  return stdout.trim();
}

// --- document format -------------------------------------------------------

test("renderHistoryDocument: frontmatter records scope, branch, session and time", () => {
  const doc = renderHistoryDocument(review(), [file("src/app.ts")], {
    date: AT,
    repo: "revgate",
    sessionId: "abc123",
    scope: "main..feature",
    branch: "feature",
    mode: "diff",
  });

  const [, front, body] = doc.split(/^---$/m);
  // Values are double-quoted: they are free text (a scope label can contain a
  // colon), and an unquoted one would make the whole block unparseable YAML.
  assert.deepEqual(front.trim().split("\n"), [
    "date: 2026-07-29T15:30:00.123Z",
    'repo: "revgate"',
    "mode: diff",
    'session: "abc123"',
    'scope: "main..feature"',
    'branch: "feature"',
  ]);
  // The body is the Task 4 annotation format, unchanged.
  assert.match(body, /^# revgate review: REQUEST CHANGES$/m);
  assert.match(body, /^## src\/app\.ts:2 \(\+\)\nUse const\.$/m);
  assert.ok(doc.endsWith("\n"));
});

test("renderHistoryDocument: a failed untracked scan survives into the archive", () => {
  // History is where a review whose live output was lost gets re-read. Dropping
  // this line there makes the recovered copy read as a complete review of the
  // turn, when every new file was in fact missing from the diff.
  const doc = renderHistoryDocument(review(), [file("src/app.ts")], {
    date: AT,
    repo: "revgate",
    scope: "working tree vs HEAD",
    mode: "diff",
    untrackedScanFailed: true,
  });
  assert.match(doc, /^untracked-scan: failed$/m);
});

test("saveHistory: the archived copy carries untracked-scan: failed", async () => {
  const dir = await tempDir();
  const saved = await saveHistory(review(), [file("src/app.ts")], {
    cwd: process.cwd(),
    scope: "working tree vs HEAD",
    mode: "diff",
    untrackedScanFailed: true,
    historyDir: dir,
    now: AT,
  });
  assert.ok(saved, "expected the review to be archived");
  assert.match(await readFile(saved as string, "utf8"), /^untracked-scan: failed$/m);
});

test("saveHistory: the archived copy carries dropped-paths", async () => {
  // Same argument as untracked-scan above: a recovered copy that omits the count
  // reads as a review of every changed file, when one of them was never rendered.
  const dir = await tempDir();
  const saved = await saveHistory(review(), [file("src/app.ts")], {
    cwd: process.cwd(),
    scope: "working tree vs HEAD",
    mode: "diff",
    droppedPaths: 2,
    historyDir: dir,
    now: AT,
  });
  assert.ok(saved, "expected the review to be archived");
  assert.match(await readFile(saved as string, "utf8"), /^dropped-paths: 2$/m);
});

test("renderHistoryDocument: optional fields are omitted, not left blank", () => {
  const doc = renderHistoryDocument(review(), [], { date: AT, repo: "no-repo", mode: "plan" });
  assert.match(doc, /^mode: plan$/m);
  assert.doesNotMatch(doc, /^session:/m);
  assert.doesNotMatch(doc, /^scope:/m);
  assert.doesNotMatch(doc, /^branch:/m);
});

// --- saving ----------------------------------------------------------------

test("saveHistory: writes <dir>/<repo>/<timestamp>.md", async (t) => {
  const repo = await createRepo({ "a.txt": "one\n" });
  const root = await tempDir();
  t.after(() => repo.cleanup());

  const dest = await saveHistory(review(), [file("src/app.ts")], {
    cwd: repo.dir,
    sessionId: "s1",
    scope: "staged changes",
    branch: "main",
    historyDir: root,
    now: AT,
  });

  assert.ok(dest, "expected a file to be written");
  const name = sanitizeSegment(path.basename(await realTop(repo.dir)));
  assert.equal(dest, path.join(root, name, "2026-07-29T15-30-00-123Z.md"));
  assert.deepEqual(await tree(root), [`${name}/2026-07-29T15-30-00-123Z.md`]);

  const content = await readFile(dest!, "utf8");
  assert.match(content, /^session: "s1"$/m);
  assert.match(content, /^scope: "staged changes"$/m);
  assert.match(content, /^## src\/app\.ts:2 \(\+\)$/m);
});

test("saveHistory: falls back to $REVGATE_HISTORY_DIR", async (t) => {
  const root = await tempDir();
  const saved = process.env.REVGATE_HISTORY_DIR;
  process.env.REVGATE_HISTORY_DIR = root;
  t.after(() => {
    if (saved === undefined) delete process.env.REVGATE_HISTORY_DIR;
    else process.env.REVGATE_HISTORY_DIR = saved;
  });

  const dest = await saveHistory(review(), [], { cwd: await tempDir(), now: AT });
  assert.equal(dest, path.join(root, "no-repo", "2026-07-29T15-30-00-123Z.md"));
});

test("saveHistory: --no-history writes nothing", async () => {
  const root = await tempDir();
  const dest = await saveHistory(review(), [], {
    cwd: root,
    historyDir: root,
    enabled: false,
    now: AT,
  });
  assert.equal(dest, null);
  assert.deepEqual(await tree(root), []);
});

test("saveHistory: an approval with no comments is not worth keeping", async () => {
  const root = await tempDir();
  const dest = await saveHistory(
    { decision: "approve", summary: "", comments: [] },
    [file("src/app.ts")],
    { cwd: root, historyDir: root, now: AT },
  );
  assert.equal(dest, null);
  assert.deepEqual(await tree(root), []);
});

test("saveHistory: an approval WITH comments is kept", async () => {
  const root = await tempDir();
  const dest = await saveHistory(review({ decision: "approve" }), [], {
    cwd: root,
    historyDir: root,
    now: AT,
  });
  assert.ok(dest);
  assert.match(await readFile(dest!, "utf8"), /^# revgate review: APPROVED$/m);
});

test("saveHistory: a request-changes with no comments is kept", async () => {
  const root = await tempDir();
  const dest = await saveHistory(review({ comments: [], summary: "" }), [], {
    cwd: root,
    historyDir: root,
    now: AT,
  });
  assert.ok(dest);
});

test("saveHistory: two reviews in the same millisecond do not overwrite", async () => {
  const root = await tempDir();
  const meta = { cwd: root, historyDir: root, now: AT };
  const first = await saveHistory(review(), [], meta);
  const second = await saveHistory(review({ summary: "second" }), [], meta);

  assert.notEqual(first, second);
  assert.equal(second, path.join(root, "no-repo", "2026-07-29T15-30-00-123Z-1.md"));
  assert.match(await readFile(second!, "utf8"), /second/);
  assert.equal((await tree(root)).length, 2);
});

test("saveHistory: an unwritable directory warns instead of throwing", async () => {
  const blocker = path.join(await tempDir(), "not-a-dir");
  // A plain file where the history root should be: mkdir cannot succeed.
  await writeFile(blocker, "in the way\n", "utf8");

  const { result, stderr } = await captureStderr(() =>
    saveHistory(review(), [], { cwd: blocker, historyDir: blocker, now: AT }),
  );
  assert.equal(result, null);
  assert.match(stderr, /WARN could not save review history/);
});

test("renderHistoryDocument: a plan scope containing colons stays parseable frontmatter", () => {
  // A plan review's scope is `plan: <the plan's own H1>`, and titles like
  // "Plan: add rate limiting" are the norm. Unquoted, this emits
  // `scope: plan: Plan: add rate limiting` — a YAML syntax error that corrupts
  // the header of every plan review ever archived.
  const doc = renderHistoryDocument(review(), [file("Plan")], {
    date: AT,
    repo: "revgate",
    scope: "plan: Plan: add rate limiting to the public API",
    mode: "plan",
  });

  const front = doc.split(/^---$/m)[1].trim().split("\n");
  const scopeLine = front.find((l) => l.startsWith("scope:"));
  assert.equal(scopeLine, 'scope: "plan: Plan: add rate limiting to the public API"');

  // Every line is still one flat `key: value` pair whose value round-trips.
  for (const line of front) {
    const match = /^([a-z]+): (.*)$/.exec(line);
    assert.ok(match, `not a flat key: value pair — ${JSON.stringify(line)}`);
    if (match[2].startsWith('"')) assert.doesNotThrow(() => JSON.parse(match[2]));
  }
});

test("renderHistoryDocument: a quote in a value is escaped, not left to break the block", () => {
  const doc = renderHistoryDocument(review(), [file("Plan")], {
    date: AT,
    repo: "revgate",
    branch: 'feat/"odd"-name',
    scope: "line1\nline2",
  });
  const front = doc.split(/^---$/m)[1].trim().split("\n");
  assert.equal(front.find((l) => l.startsWith("branch:")), 'branch: "feat/\\"odd\\"-name"');
  // A newline in a value must not become a second frontmatter line.
  // date, repo, mode, scope, branch — and nothing a value smuggled in.
  assert.equal(front.length, 5, "a value's newline leaked into the frontmatter block");
  assert.equal(front.find((l) => l.startsWith("scope:")), 'scope: "line1\\nline2"');
});

test("saveHistory: a malformed submission is skipped, never thrown to the caller", async (t) => {
  // saveHistory's contract is "never throws" — a throw here reaches the hook's
  // fail-open handler, which reports the review as an *approval*.
  const repo = await createRepo({ "a.txt": "one\n" });
  const root = await tempDir();
  t.after(() => repo.cleanup());

  const broken = { decision: "request_changes" } as unknown as ReviewSubmission;
  const { result, stderr } = await captureStderr(() =>
    saveHistory(broken, [file("src/app.ts")], { cwd: repo.dir, historyDir: root, now: AT }),
  );
  assert.equal(result, null);
  // null alone would also be the answer for `enabled: false` or "no findings", so
  // pin the assertion to the catch: the throw was swallowed, not sidestepped.
  assert.match(stderr, /WARN could not save review history/);
});
