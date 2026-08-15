import { parseUnifiedDiff } from "../review/diff.js";
import { warn } from "../shared/log.js";
import { git, gitDiff, gitErrorMessage, hasHead, isGitRepo, repoRoot } from "./exec.js";
import { describeScope, ScopeError, verifyArity, verifyRef, type DiffScope } from "./scope.js";
import { newUntrackedBudget, untrackedFileDiff } from "./untracked.js";

/** One scope's collected diff, plus what could not be collected. */
export interface RepoDiff {
  isRepo: boolean;
  /** Concatenated unified diff text for all changes (tracked + untracked). */
  unified: string;
  branch: string | null;
  /** Untracked paths synthesized into the diff, and what was diffed overall. */
  untracked: string[];
  scopeLabel: string;
  /** True when the untracked scan failed, so this diff covers tracked changes only. */
  untrackedScanFailed?: boolean;
  /** How many untracked files were dropped for a line break in their name. */
  droppedUntracked?: number;
}

/**
 * Collect the unified diff for `scope`, throwing ScopeError if a ref does not
 * resolve. Untracked files are synthesized for the worktree scope ONLY, since a
 * ref, range or staged review is about committed or indexed content.
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

  // The trailing `--` keeps a ref that names a file from becoming a pathspec.
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
          // Fresh repo, no commits yet: staged changes are the only tracked diff.
          try {
            tracked = await gitDiff(cwd, ["--cached", "--"]);
          } catch {
            tracked = "";
          }
        }
    }
  } catch (err) {
    // Every ref cleared individually already, so a failure here is the
    // *combination* being unusable. That is bad usage: exit 2, not a stack trace.
    throw new ScopeError(gitErrorMessage(err, `could not diff ${scopeLabel}`));
  }

  let untracked: string[] = [];
  let untrackedScanFailed = false;
  let droppedUntracked = 0;
  // From the root, so the paths match the root-relative ones `git diff` emitted.
  const root = await repoRoot(cwd);
  if (scope.kind === "worktree") {
    try {
      // `-z` for the same reason as `status`: the newline form is C-quoted for
      // non-ASCII paths, and a quoted name resolves on nothing.
      const out = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
      untracked = out.split("\0").filter(Boolean).filter((p) => {
        if (!/[\r\n]/.test(p)) return true;
        // Counted, not just warned: dropping the only changed file must reach
        // the report, never read as an empty-diff approval.
        droppedUntracked++;
        warn(`skipping untracked file whose name contains a newline: ${JSON.stringify(p)}`);
        return false;
      });
    } catch (err) {
      // Swallowed, this drops *every* untracked file at once, which reads
      // downstream as "nothing to review, approve". Say it, and carry it.
      untrackedScanFailed = true;
      warn(gitErrorMessage(err, "could not list untracked files"));
    }
  }

  // A path can appear in BOTH lists (`git rm --cached x`). Two DiffFiles with one
  // `path` double-count it and make `files.find(...)` hit the deleted entry.
  if (untracked.length && tracked.trim()) {
    const inTracked = new Set(parseUnifiedDiff(tracked).map((f) => f.path));
    untracked = untracked.filter((p) => !inTracked.has(p));
  }

  const parts: string[] = [];
  if (tracked.trim()) parts.push(tracked);
  // One allowance shared by the whole set — see MAX_UNTRACKED_TOTAL_BYTES.
  const budget = newUntrackedBudget();
  for (const f of untracked) {
    const d = await untrackedFileDiff(root, f, budget);
    if (d) parts.push(d);
  }
  if (budget.elided > 0) {
    // Once: a per-file line would itself be the flood.
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
