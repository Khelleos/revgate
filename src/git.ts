import { execFile } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { warn } from "./log.js";
import { parseUnifiedDiff } from "./diff.js";
import type { DiffFile, StageState } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Config this process forces on every git invocation, because the reviewer's own
 * `~/.gitconfig` would otherwise decide what the gate sees. Each one of these,
 * left inherited, either drops files from the review or renames them — and a
 * review that silently omits a file is an approval of code nobody looked at.
 *
 * - `core.quotePath`: by default git C-quotes any path containing a non-ASCII
 *   byte, so `café.txt` reaches us as `"caf\303\251.txt"` — a name that matches
 *   nothing on disk, nothing in the `-z` output of `status`/`ls-files` (which is
 *   never quoted), and no `-I`/`-X` prefix. The file vanishes from the review,
 *   and any annotation written about it points at a path that does not exist.
 * - `diff.relative`: makes `git diff` emit cwd-relative paths AND omit
 *   everything outside the cwd subtree. Run from a subdirectory — which is
 *   exactly how an agent invokes `revgate review` — the diff arrives with the
 *   rest of the repo's changes already gone, and `collectDiff` cannot tell that
 *   from "nothing else changed".
 * - `diff.mnemonicPrefix` / `diff.noprefix` / `diff.srcPrefix` / `diff.dstPrefix`:
 *   all four rewrite the `a/`…`b/` header prefixes that `stripPrefix` in diff.ts
 *   removes (to `c/`…`w/`, to nothing, or to anything at all). Every resulting
 *   `DiffFile.path` is then wrong, so `-I`/`-X` match nothing, `getStageStates`
 *   lookups miss, and the annotations name paths that do not exist. Pinning the
 *   prefixes is safe on older git too: `diff.srcPrefix`/`dstPrefix` arrived in
 *   2.41, and `-c` on a key an older git does not know is simply ignored.
 * - `status.showUntrackedFiles`: set to `no`, `git status --porcelain` stops
 *   reporting `??` records, so `getStageStates` has no entry for the untracked
 *   files `ls-files` did find.
 *
 * Setting these here rather than per-command means no future call site can
 * forget. `diff.external` cannot be neutralized this way and is handled by
 * `gitDiff` below.
 */
const HARDENED_CONFIG = [
  "core.quotePath=false",
  "diff.relative=false",
  "diff.noprefix=false",
  "diff.mnemonicPrefix=false",
  "diff.srcPrefix=a/",
  "diff.dstPrefix=b/",
  "status.showUntrackedFiles=normal",
].flatMap((kv) => ["-c", kv]);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...HARDENED_CONFIG, ...args], {
    cwd,
    maxBuffer: 64 * 1024 * 1024, // 64MB — diffs can be large
    windowsHide: true,
  });
  return stdout;
}

/**
 * `git diff` with the external diff driver forced off.
 *
 * `diff.external` (and `GIT_EXTERNAL_DIFF`) replaces git's unified output with
 * an arbitrary program's, which `parseUnifiedDiff` cannot read — so a reviewer
 * with difftastic or similar wired up globally would get an empty review.
 * Unlike the settings in HARDENED_CONFIG there is no `-c` value that disables
 * it: `-c diff.external=` makes git try to spawn the empty string and die with
 * "external diff died". Only the flag works, so it lives on this one helper
 * that every diff invocation goes through.
 */
function gitDiff(cwd: string, args: string[]): Promise<string> {
  return git(cwd, ["diff", "--no-ext-diff", "--no-color", ...args]);
}

/**
 * A one-line reason from a failed git invocation. Prefers git's own `fatal:`
 * line on stderr over execFile's "Command failed: git diff …" wrapper, which
 * echoes the whole argv and tells the reader nothing.
 */
function gitErrorMessage(err: unknown, fallback: string): string {
  const stderr = (err as { stderr?: string } | null)?.stderr;
  const line = typeof stderr === "string"
    ? stderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
    : undefined;
  return line ? `${fallback}: ${line}` : fallback;
}

/** True if the repo has at least one commit (so HEAD resolves). */
async function hasHead(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Absolute path to the repository root, or null when `cwd` is not inside a work
 * tree. `repoRoot` below is the "give me somewhere to run" form; callers that
 * must tell "not a repo" apart from "cwd happens to be the root" need this one.
 */
export async function findRepoRoot(cwd: string): Promise<string | null> {
  try {
    const out = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Absolute path to the repository root.
 *
 * Every path revgate handles is repo-root-relative, because that is what
 * `git diff` and `git status --porcelain` emit from *any* directory. Two git
 * commands break that rule and must therefore run from the root:
 *
 * - `ls-files --others` prints cwd-relative paths AND only walks the cwd
 *   subtree, so from `repo/sub` it both renames and silently drops untracked
 *   files — leaving them in a different namespace from the tracked diff, which
 *   breaks `filterFiles` prefix matching and the `getStageStates` lookup.
 * - `add`/`reset -- <path>` resolve their pathspec against the cwd, so a
 *   root-relative path posted by the UI would miss from a subdirectory.
 *
 * Falls back to `cwd` when the root can't be resolved (no repo, old git).
 */
async function repoRoot(cwd: string): Promise<string> {
  return (await findRepoRoot(cwd)) ?? cwd;
}

function looksBinary(buf: Buffer): boolean {
  // Heuristic mirroring git: a NUL byte in the first 8KB => treat as binary.
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Largest untracked file inlined into the review.
 *
 * The tracked diff is bounded by git's own output and `maxBuffer`; an untracked
 * file is read from disk by us. Above this it is listed but not expanded: whole
 * files are read into memory, split into per-line objects, and JSON-serialized to
 * the browser, so one stray log or dump would spike memory and produce a UI
 * nobody can scroll. Not a diff worth showing either way.
 */
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;

/**
 * Ceilings across *all* untracked files in one review, not just each one.
 *
 * MAX_UNTRACKED_BYTES bounds a single file, but the worktree scope expands every
 * untracked path there is, and the hook runs that on every finished agent turn.
 * A directory `.gitignore` does not cover — a data dump, a `dist/` tree in a
 * fresh clone, a vendored dependency — is read whole, concatenated into one
 * `unified` string, re-split into per-line objects by `parseUnifiedDiff`, and
 * JSON-serialized to the browser: three copies of everything. Unbounded, that is
 * an OOM or a hook that never returns before its timeout, so the gate hangs the
 * agent instead of gating it. Note that `filterFiles` runs after this, so `-I`/
 * `-X` cannot reduce the work. Past either ceiling files are still listed, just
 * unexpanded — a file must never silently leave the review.
 */
const MAX_UNTRACKED_TOTAL_BYTES = 8 * 1024 * 1024;
/** Same reasoning, for a wide tree of small files that never reaches the byte total. */
const MAX_UNTRACKED_FILES = 300;

/** Remaining allowance for one `collectDiff` call, spent by `untrackedFileDiff`. */
interface UntrackedBudget {
  bytes: number;
  files: number;
  /** How many paths were listed unexpanded because the budget ran out. */
  elided: number;
}

/**
 * Synthesize an "all added" unified diff for an untracked file, since
 * `git diff HEAD` never reports files git isn't tracking yet.
 */
async function untrackedFileDiff(
  cwd: string,
  relPath: string,
  budget: UntrackedBudget,
): Promise<string> {
  const abs = path.resolve(cwd, relPath);

  // Mode is not decoration: git records a symlink as `120000` and the UI/parser
  // read the header, so a link announced as a regular file is a lie about what
  // the repository would gain on commit.
  const headerFor = (mode: string) =>
    `diff --git a/${relPath} b/${relPath}\n` +
    `new file mode ${mode}\n` +
    `--- /dev/null\n` +
    `+++ b/${relPath}\n`;
  const header = headerFor("100644");
  // `Binary files … differ` is how the UI renders "present in the review, but not
  // expanded" — the same treatment an oversized file needs.
  const binaryLine = `Binary files /dev/null and b/${relPath} differ\n`;
  const unexpanded = header + binaryLine;

  let buf: Buffer;
  try {
    // Size first: reading to find out how big it is defeats the point of a cap.
    //
    // Before the file budget, too. The budget decides whether a path is
    // *expanded*, never what it *is*, and returning early on it announced an
    // elided symlink as mode 100644 — the same lie about what the repository
    // would gain on commit that the mode handling below exists to prevent. Past
    // the 300-file ceiling every untracked link read as a new regular file.
    //
    // `lstat`, not `stat`: `ls-files --others` lists untracked symlinks too, and
    // following one is wrong twice over. Git stores a symlink as mode 120000
    // whose entire content is the target path, so dereferencing puts content
    // that is not in the repository into the review and into the markdown
    // archived under ~/.revgate/history — an untracked `config -> ~/.aws/creds`
    // would get its secrets inlined. It also defeated both ceilings: `stat` on a
    // link to a FIFO or /dev/zero reports size 0, so it passed the per-file and
    // budget checks alike, and the `readFile` then blocked forever or grew until
    // OOM — the hook hanging the agent instead of gating it, which is precisely
    // what MAX_UNTRACKED_* exists to prevent.
    const info = await lstat(abs);
    const isLink = info.isSymbolicLink();
    if (budget.files <= 0) {
      budget.elided++;
      return headerFor(isLink ? "120000" : "100644") + binaryLine;
    }
    if (isLink) {
      // Charged like any other expansion; a link's `lstat` size is its target's
      // length, which is what we are about to inline.
      budget.bytes -= info.size;
      budget.files--;
      const target = await readlink(abs);
      // Same reason collectDiff drops paths containing newlines: this string
      // becomes diff content, and a newline in it splices a phantom record into
      // every line-oriented consumer downstream.
      if (/[\r\n]/.test(target)) {
        warn(
          `untracked symlink ${relPath} points at a path containing a newline — ` +
            `listing it without a diff`,
        );
        return headerFor("120000") + binaryLine;
      }
      // Exactly what `git diff` emits for a new symlink: one added line, no
      // trailing newline.
      return (
        headerFor("120000") + `@@ -0,0 +1 @@\n+${target}\n\\ No newline at end of file\n`
      );
    }
    if (!info.isFile()) {
      // A FIFO, socket or device node git happened to list. There is no file
      // content to show, and `readFile` on one either blocks with no writer or
      // never ends — the hang the caps exist to prevent.
      warn(`untracked path ${relPath} is not a regular file — listing it without a diff`);
      return unexpanded;
    }
    if (info.size > MAX_UNTRACKED_BYTES) {
      warn(`untracked file ${relPath} is ${info.size} bytes — listing it without a diff`);
      return unexpanded;
    }
    if (info.size > budget.bytes) {
      budget.elided++;
      return unexpanded;
    }
    buf = await readFile(abs);
    // Charged before the binary/empty checks below: the read already happened, and
    // those paths still cost a whole file's worth of memory to reach.
    budget.bytes -= info.size;
    budget.files--;
  } catch (err) {
    // Listed unexpanded, never dropped. Returning "" here removed the file from
    // `collectDiff`'s output entirely, so it reached neither the UI nor the
    // annotations — the one path where a file silently left the review, which is
    // the invariant every other branch above exists to keep. A file that
    // disappeared or turned unreadable between `ls-files` and `readFile` is
    // exactly the kind of thing a reviewer needs to see named.
    warn(`could not read untracked file ${relPath}: ${(err as Error).message}`);
    return unexpanded;
  }

  if (looksBinary(buf)) {
    return unexpanded;
  }

  const text = buf.toString("utf8");
  // Split but drop the trailing empty element from a final newline.
  const rawLines = text.split("\n");
  if (rawLines.length && rawLines[rawLines.length - 1] === "") rawLines.pop();
  if (rawLines.length === 0) return header; // empty new file — nothing to show

  const hunk = `@@ -0,0 +1,${rawLines.length} @@\n`;
  const body = rawLines.map((l) => `+${l}`).join("\n") + "\n";
  const noNewlineAtEof = !text.endsWith("\n");
  return header + hunk + body + (noNewlineAtEof ? "\\ No newline at end of file\n" : "");
}

export interface RepoDiff {
  isRepo: boolean;
  /** Concatenated unified diff text for all changes (tracked + untracked). */
  unified: string;
  branch: string | null;
  /** Untracked file paths that were synthesized into the diff. */
  untracked: string[];
  /** Human-readable description of what was diffed, e.g. `main..feature`. */
  scopeLabel: string;
  /**
   * True when the untracked scan itself failed, so this diff covers tracked
   * changes only and nobody knows what is missing. Every other drop path in this
   * module keeps the file listed-but-unexpanded; a failed `ls-files` has no list
   * to keep, so the fact of the failure is what gets carried instead — otherwise
   * a turn that only added new files reports APPROVED with `files: 0`.
   */
  untrackedScanFailed?: boolean;
  /**
   * How many untracked files were dropped for carrying a line break in their
   * name. Carried for the same reason `parseUnifiedDiff` reports its own drops:
   * a tree whose only change is such a file would otherwise review as APPROVED
   * with `files: 0`, and only stderr said the file existed — which is exactly
   * what an agent reading `-o <file>` never sees.
   */
  droppedUntracked?: number;
}

/**
 * Which changes a review covers. Declared here, next to the code that acts on
 * it, and imported directly by `cli.ts` for the argv side — one declaration, so
 * the parser and the collector cannot drift apart.
 */
export interface DiffScope {
  kind: "worktree" | "staged" | "ref" | "range";
  /** `[]` for worktree/staged, `[ref]` for a single ref, `[a, b]` for a range. */
  refs: string[];
  /** Range separator: ".." compares the endpoints, "..." compares from the merge base. */
  dots?: ".." | "...";
  /** Only keep paths starting with one of these prefixes (empty = keep all). */
  include: string[];
  /** Drop paths starting with one of these prefixes. */
  exclude: string[];
}

/**
 * A scope that git cannot honour — an unknown ref, mostly. Distinct from a
 * crash so callers can report bad usage (exit 2) instead of an internal error.
 */
export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeError";
  }
}

/** The label shown in the UI header and used in log lines. */
export function describeScope(scope: DiffScope): string {
  let label: string;
  switch (scope.kind) {
    case "staged":
      label = "staged changes";
      break;
    case "ref":
      label = `${scope.refs[0]} vs working tree`;
      break;
    case "range":
      label = `${scope.refs[0]}${scope.dots ?? ".."}${scope.refs[1]}`;
      break;
    default:
      label = "working tree vs HEAD";
  }

  // Path filters belong in the label: they are why an otherwise busy scope can
  // come back empty, and "No changes to review in main..feature" is a lie when
  // it was `-I src` that emptied it.
  //
  // A filter value is user text — revgate-review's SKILL tells the agent to turn
  // its path argument into `-I <arg>` — and this label is emitted verbatim as the
  // report's `scope:` header. A line break in it would splice a forged
  // `## file:line (+)` record into the annotation output: a review directive no
  // reviewer wrote. Same splicing the tracked (diff.ts) and untracked (above)
  // path guards exist to stop, so keep the label on one line.
  const oneLine = (p: string): string => p.replace(/[\r\n]+/g, " ");
  const filters = [
    ...scope.include.filter(Boolean).map((p) => `+${oneLine(p)}`),
    ...scope.exclude.filter(Boolean).map((p) => `-${oneLine(p)}`),
  ];
  return filters.length ? `${label} [${filters.join(" ")}]` : label;
}

/**
 * A scope must carry exactly the refs its kind implies. parseArgs guarantees
 * this, but collectDiff is also called with scopes built by hand — and a missing
 * ref would reach execFile as `undefined` and crash with an opaque
 * ERR_INVALID_ARG_TYPE instead of a usage error.
 */
function verifyArity(scope: DiffScope): void {
  const want = scope.kind === "ref" ? 1 : scope.kind === "range" ? 2 : 0;
  if (scope.refs.length !== want) {
    throw new ScopeError(
      `a ${scope.kind} scope needs exactly ${want} ref(s), got ${scope.refs.length}`,
    );
  }
}

/**
 * Resolve a ref before handing it to `git diff`, so a typo (or anything else
 * that isn't a commit) is reported as bad usage rather than as a git crash.
 */
async function verifyRef(cwd: string, ref: string): Promise<void> {
  // A leading dash would be read by git as a flag; parseArgs never produces one,
  // but collectDiff is also called with scopes built by hand.
  if (!ref || ref.startsWith("-")) {
    throw new ScopeError(`invalid git ref: ${ref || "(empty)"}`);
  }
  try {
    await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  } catch {
    throw new ScopeError(`unknown git ref: ${ref}`);
  }
}

/** Compare paths with forward slashes so a Windows-style prefix still matches. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Reduce a user-supplied `-I`/`-X` prefix to the root-relative, slash-separated
 * form `git diff` emits, so the natural spellings all land on the same target.
 *
 * `./src`, `/src` and `src/` are how a shell tab-completion, a human, and an
 * agent respectively tend to write "the src directory", but only the last one
 * used to match: the others compared literally against `src/a.ts` and matched
 * nothing. An include filter that matches nothing is the dangerous direction —
 * `reviewDiff` sees an empty file list, takes the "nothing to review" branch,
 * prints APPROVED and exits 0, so `revgate review -I ./src` reports a clean
 * review of a diff it never showed anyone.
 *
 * Returns `""` for every spelling of the repository root (``, `/`, `.`, `./`),
 * which `matchesPrefix` reads as "the whole tree".
 */
function normalizePrefix(prefix: string): string {
  let clean = normalizePath(prefix).replace(/\/+$/, "");
  while (clean.startsWith("./")) clean = clean.slice(2);
  if (clean === ".") return "";
  return clean.replace(/^\/+/, "");
}

/**
 * Does `p` sit at or under the path prefix `prefix`?
 *
 * A raw `startsWith` would match on any string boundary: `src` would claim
 * `src-generated/x.ts`, and `src/a.ts` would claim `src/a.tsx`. Over-inclusion is
 * only noise, but over-*exclusion* silently drops files from the review — so
 * `-X src/generated` must not also remove `src/generated-old.ts`.
 */
function matchesPrefix(p: string, prefix: string): boolean {
  const clean = normalizePrefix(prefix);
  if (!clean) return true; // `/`, `.` — the whole tree
  return p === clean || p.startsWith(`${clean}/`);
}

/**
 * Narrow a parsed diff to the requested paths. Include runs first (an empty
 * include list keeps everything), then exclude removes from what survived —
 * the composition revdiff documents, so `-I src -X src/vendor` does what it reads like.
 */
export function filterFiles(files: DiffFile[], scope: Pick<DiffScope, "include" | "exclude">): DiffFile[] {
  const include = scope.include.map(normalizePath).filter(Boolean);
  const exclude = scope.exclude.map(normalizePath).filter(Boolean);
  if (!include.length && !exclude.length) return files;

  return files.filter((f) => {
    const p = normalizePath(f.path);
    if (include.length && !include.some((prefix) => matchesPrefix(p, prefix))) return false;
    return !exclude.some((prefix) => matchesPrefix(p, prefix));
  });
}

/**
 * Collect the unified diff for `scope`. The default (worktree) captures
 * everything Copilot changed relative to HEAD: staged + unstaged edits to
 * tracked files, plus brand-new untracked files.
 *
 * Untracked files are synthesized for the worktree scope ONLY — a ref, range or
 * staged review is about committed/indexed content, and folding in whatever
 * happens to be lying around the working tree would misreport that scope.
 *
 * Throws ScopeError if a ref doesn't resolve.
 */
export async function collectDiff(cwd: string, scope: DiffScope): Promise<RepoDiff> {
  verifyArity(scope);
  const scopeLabel = describeScope(scope);

  if (!(await isGitRepo(cwd))) {
    return { isRepo: false, unified: "", branch: null, untracked: [], scopeLabel };
  }

  let branch: string | null = null;
  try {
    branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  } catch {
    /* detached or no commits */
  }

  for (const ref of scope.refs) await verifyRef(cwd, ref);

  // The trailing `--` separates revisions from pathspecs, so a ref that happens
  // to share a name with a file can never be reinterpreted as a path.
  let tracked = "";
  try {
    switch (scope.kind) {
      case "staged":
        tracked = await gitDiff(cwd, ["--cached", "--"]);
        break;
      case "ref":
        tracked = await gitDiff(cwd, [scope.refs[0], "--"]);
        break;
      case "range":
        tracked = await gitDiff(
          cwd,
          scope.dots === "..."
            ? [`${scope.refs[0]}...${scope.refs[1]}`, "--"]
            : [scope.refs[0], scope.refs[1], "--"],
        );
        break;
      default:
        if (await hasHead(cwd)) {
          // Working tree vs HEAD captures both staged and unstaged changes.
          tracked = await gitDiff(cwd, ["HEAD", "--"]);
        } else {
          // Fresh repo, no commits yet: staged changes are the only "tracked" diff.
          try {
            tracked = await gitDiff(cwd, ["--cached", "--"]);
          } catch {
            tracked = "";
          }
        }
    }
  } catch (err) {
    // verifyRef already cleared every ref individually, so a failure here is
    // the *combination* being unusable — `a...b` with no merge base is the
    // common one. That is bad usage, not a crash: rethrowing as ScopeError
    // keeps it on the documented exit-2 path instead of printing a stack trace
    // and exiting 1, which the skills read as "a real error, do not retry".
    throw new ScopeError(gitErrorMessage(err, `could not diff ${scopeLabel}`));
  }

  // Untracked files (respecting .gitignore) — worktree scope only.
  let untracked: string[] = [];
  let untrackedScanFailed = false;
  let droppedUntracked = 0;
  // From the root, so the paths match the root-relative ones `git diff` just
  // emitted and nothing outside a subdirectory cwd is dropped — see repoRoot.
  const root = await repoRoot(cwd);
  if (scope.kind === "worktree") {
    try {
      // `-z` for the same reason as `status` below: NUL-terminated records are
      // the only form git emits verbatim. Newline-separated output is C-quoted
      // whenever a path has non-ASCII bytes (`"caf\303\251.txt"`), and that
      // quoted string does not resolve on disk — the file would be read as
      // unreadable and silently dropped from the review.
      const out = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
      untracked = out.split("\0").filter(Boolean).filter((p) => {
        // git permits newlines in filenames, and everything downstream of here
        // is line-oriented: the synthesized diff below interpolates the path
        // into `diff --git a/<p> b/<p>`, and the annotation renderer into
        // `## <p>:<line>`. A path carrying a newline would splice phantom
        // records into both — a file entry, or a review directive, that does not
        // correspond to anything on disk.
        if (!/[\r\n]/.test(p)) return true;
        // Counted, not just warned: dropping the only changed file in the tree
        // must reach the report as PATHS DROPPED, never as an empty-diff
        // approval — see `droppedUntracked` on RepoDiff.
        droppedUntracked++;
        warn(`skipping untracked file whose name contains a newline: ${JSON.stringify(p)}`);
        return false;
      });
    } catch (err) {
      // Swallowing this dropped *every* untracked file from the review at once —
      // a locked or corrupt index, an unreadable `core.excludesFile`, a path list
      // past `maxBuffer`. For the common turn whose whole output is new files
      // that left an empty diff, which reads downstream as "nothing to review,
      // approve": exactly the silent approval of unseen code the rest of this
      // module is built to prevent. Say it, and carry it so the report can too.
      untrackedScanFailed = true;
      warn(gitErrorMessage(err, "could not list untracked files"));
    }
  }

  // A path can appear in BOTH lists. `git rm --cached x` stages a deletion — so
  // `diff HEAD` reports `x` — while leaving the file on disk and untracked, so
  // `ls-files --others` reports it too. Synthesizing a diff for it as well emits
  // two DiffFiles with the same `path`, one isDeleted and one isNew, which
  // double-counts the file, renders two indistinguishable sidebar rows, lists
  // every remark on that path twice in the rail, and makes `rangeLines`'
  // `files.find(...)` always resolve to the deleted entry — so a new-side comment
  // quotes no code back to the agent. The tracked diff is the authoritative view
  // of the path against the reviewed base, so it wins and the untracked copy goes.
  if (untracked.length && tracked.trim()) {
    const inTracked = new Set(parseUnifiedDiff(tracked).map((f) => f.path));
    untracked = untracked.filter((p) => !inTracked.has(p));
  }

  const parts: string[] = [];
  if (tracked.trim()) parts.push(tracked);
  // One allowance shared by the whole set — see MAX_UNTRACKED_TOTAL_BYTES.
  const budget: UntrackedBudget = {
    bytes: MAX_UNTRACKED_TOTAL_BYTES,
    files: MAX_UNTRACKED_FILES,
    elided: 0,
  };
  for (const f of untracked) {
    const d = await untrackedFileDiff(root, f, budget);
    if (d) parts.push(d);
  }
  if (budget.elided > 0) {
    // Once, not per file: the interesting number is how much of the review is
    // listed but unreadable, and a per-file line would itself be the flood.
    warn(
      `${budget.elided} untracked file(s) listed without a diff — ` +
        `this review hit its untracked-content budget`,
    );
  }

  return {
    isRepo: true,
    unified: parts.join(""),
    branch,
    untracked,
    scopeLabel,
    untrackedScanFailed,
    droppedUntracked,
  };
}

/**
 * True for the `git status` column pairs that mean "unmerged", i.e. a conflict.
 *
 * These are NOT a staged/unstaged split: the index holds conflict stages 1/2/3
 * rather than one resolved blob. Both columns are non-blank, so without this they
 * classify as "partial" — an indeterminate checkbox whose unstage direction runs
 * `git reset -- <path>`, which drops those stages. Status then flips from `UU` to
 * ` M` while MERGE_HEAD and the conflict markers remain, so the conflict *looks*
 * resolved and the next commit records the markers as the resolution.
 */
function isUnmerged(x: string, y: string): boolean {
  return x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
}

/**
 * Map each changed path to whether its changes are staged, by parsing
 * `git status --porcelain`. The two status columns are X (index vs HEAD)
 * and Y (working tree vs index): a non-blank X means something is staged,
 * a non-blank Y means unstaged changes remain.
 */
export async function getStageStates(cwd: string): Promise<Record<string, StageState>> {
  const states: Record<string, StageState> = {};
  let out: string;
  try {
    // NUL-terminated records so paths with spaces/quotes parse cleanly.
    out = await git(cwd, ["status", "--porcelain=v1", "-z"]);
  } catch (err) {
    warn(`could not read git status: ${(err as Error).message}`);
    return states;
  }

  const tokens = out.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const rec = tokens[i];
    if (rec.length < 3) continue;
    const x = rec[0];
    const y = rec[1];
    const p = rec.slice(3);
    // Rename/copy records carry the original path in the NEXT NUL field. Either
    // column can hold the R/C: `R  new` is a rename staged in the index, ` R new`
    // one git detected in the working tree (an `add -N` on the new path). Testing
    // only X leaves the origin path to be parsed as its own record on the next
    // pass, which synthesizes a state for `<origin>.slice(3)` — a bogus key that
    // looks like a real repo path (`ui/src/app.ts` -> `src/app.ts`) and, because
    // git sorts by the *new* path, can land after and overwrite the genuine
    // record for that file.
    if (x === "R" || x === "C" || y === "R" || y === "C") i++;

    if (x === "?") {
      // A path can hold both a tracked record and an untracked one: after
      // `git rm --cached x`, status prints `D  x` (deletion staged) followed by
      // `?? x` (the file is still on disk). git emits the `??` records last, so a
      // plain assignment here is last-record-wins and buries the staged deletion
      // under "no" — the UI then shows "Not staged" for a change that is staged,
      // and ticking the toggle runs `git add` and silently reverts the deletion.
      // The tracked record is the one that describes the index, so it stands.
      if (!(p in states)) states[p] = "no"; // untracked — nothing staged
    } else if (isUnmerged(x, y)) {
      states[p] = "unmerged"; // a conflict: staging is not a meaningful action
    } else if (x !== " " && y !== " ") {
      states[p] = "partial"; // staged, but the working tree diverged again
    } else if (x !== " ") {
      states[p] = "yes"; // fully staged
    } else {
      states[p] = "no"; // only a working-tree change
    }
  }
  return states;
}

/**
 * Stage or unstage a single path, then return the refreshed states so the UI
 * can reflect the real index (git may reclassify neighbours on a rename).
 */
export async function setStaged(
  cwd: string,
  file: string,
  staged: boolean,
): Promise<Record<string, StageState>> {
  // `file` is repo-root-relative (that is what the diff and status parsers
  // produce), and git resolves a pathspec against the cwd — so run from the
  // root or a subdirectory cwd would stage the wrong path, or nothing.
  const root = await repoRoot(cwd);
  try {
    if (staged) {
      // `add` handles modified, new, and deleted paths alike.
      await git(root, ["add", "--", file]);
    } else {
      // `reset` unstages whether or not HEAD exists (fresh repos included).
      await git(root, ["reset", "-q", "--", file]);
    }
  } catch (err) {
    // Propagate rather than warn-and-return-states: swallowing it here made
    // `/api/stage` answer 200 with the *unchanged* states, so the browser could
    // not tell "git refused" from "git says it is already in that state". The
    // checkbox just snapped back with nothing in the UI to explain why — and
    // `.git/index.lock` held by a concurrent git process is a routine cause.
    throw new Error(
      gitErrorMessage(err, `could not ${staged ? "stage" : "unstage"} ${file}`),
    );
  }
  return getStageStates(root);
}
