import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Config forced on every git invocation. Each key, left inherited, renames or
 * silently drops files from the review. See the git rule in agents.md.
 */
export const HARDENED_CONFIG = [
  "core.quotePath=false",
  "diff.relative=false",
  "diff.noprefix=false",
  "diff.mnemonicPrefix=false",
  "diff.srcPrefix=a/",
  "diff.dstPrefix=b/",
  "status.showUntrackedFiles=normal",
].flatMap((kv) => ["-c", kv]);

/** The one place this project spawns git. Internal to `src/git/`. */
export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...HARDENED_CONFIG, ...args], {
    cwd,
    maxBuffer: 64 * 1024 * 1024, // 64MB — diffs can be large
    windowsHide: true,
  });
  return stdout;
}

/** `git diff` with `diff.external` forced off — the one setting `-c` cannot disable. */
export function gitDiff(cwd: string, args: string[]): Promise<string> {
  return git(cwd, ["diff", "--no-ext-diff", "--no-color", ...args]);
}

/** A one-line reason from a failed git invocation, preferring git's own `fatal:` line. */
export function gitErrorMessage(err: unknown, fallback: string): string {
  const stderr = (err as { stderr?: string } | null)?.stderr;
  const line = typeof stderr === "string"
    ? stderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
    : undefined;
  return line ? `${fallback}: ${line}` : fallback;
}

/** True if the repo has at least one commit (so HEAD resolves). */
export async function hasHead(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/** True if `cwd` sits inside a git work tree. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path to the repository root, or null when `cwd` is not inside a work tree. */
export async function findRepoRoot(cwd: string): Promise<string | null> {
  try {
    const out = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * The repository root, falling back to `cwd`. Every revgate path is
 * root-relative, and `ls-files --others` and `add`/`reset` resolve against the cwd.
 */
export async function repoRoot(cwd: string): Promise<string> {
  return (await findRepoRoot(cwd)) ?? cwd;
}
