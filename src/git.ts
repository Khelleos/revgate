import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { warn } from "./log.js";
import type { StageState } from "./types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024, // 64MB — diffs can be large
    windowsHide: true,
  });
  return stdout;
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

function looksBinary(buf: Buffer): boolean {
  // Heuristic mirroring git: a NUL byte in the first 8KB => treat as binary.
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Synthesize an "all added" unified diff for an untracked file, since
 * `git diff HEAD` never reports files git isn't tracking yet.
 */
async function untrackedFileDiff(cwd: string, relPath: string): Promise<string> {
  const abs = path.resolve(cwd, relPath);
  let buf: Buffer;
  try {
    buf = await readFile(abs);
  } catch (err) {
    warn(`could not read untracked file ${relPath}: ${(err as Error).message}`);
    return "";
  }

  const header =
    `diff --git a/${relPath} b/${relPath}\n` +
    `new file mode 100644\n` +
    `--- /dev/null\n` +
    `+++ b/${relPath}\n`;

  if (looksBinary(buf)) {
    return header + `Binary files /dev/null and b/${relPath} differ\n`;
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
}

/**
 * Collect everything Copilot changed in the working tree relative to HEAD:
 * staged + unstaged edits to tracked files, plus brand-new untracked files.
 */
export async function collectWorkingTreeDiff(cwd: string): Promise<RepoDiff> {
  if (!(await isGitRepo(cwd))) {
    return { isRepo: false, unified: "", branch: null, untracked: [] };
  }

  let branch: string | null = null;
  try {
    branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  } catch {
    /* detached or no commits */
  }

  let tracked = "";
  if (await hasHead(cwd)) {
    // Working tree vs HEAD captures both staged and unstaged changes.
    tracked = await git(cwd, ["diff", "--no-color", "HEAD"]);
  } else {
    // Fresh repo, no commits yet: staged changes are the only "tracked" diff.
    try {
      tracked = await git(cwd, ["diff", "--no-color", "--cached"]);
    } catch {
      tracked = "";
    }
  }

  // Untracked files (respecting .gitignore).
  let untracked: string[] = [];
  try {
    const out = await git(cwd, ["ls-files", "--others", "--exclude-standard"]);
    untracked = out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    /* ignore */
  }

  const parts: string[] = [];
  if (tracked.trim()) parts.push(tracked);
  for (const f of untracked) {
    const d = await untrackedFileDiff(cwd, f);
    if (d) parts.push(d);
  }

  return {
    isRepo: true,
    unified: parts.join(""),
    branch,
    untracked,
  };
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
    // Rename/copy records carry the original path in the NEXT NUL field.
    if (x === "R" || x === "C") i++;

    if (x === "?" ) {
      states[p] = "no"; // untracked — nothing staged
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
  try {
    if (staged) {
      // `add` handles modified, new, and deleted paths alike.
      await git(cwd, ["add", "--", file]);
    } else {
      // `reset` unstages whether or not HEAD exists (fresh repos included).
      await git(cwd, ["reset", "-q", "--", file]);
    }
  } catch (err) {
    warn(`could not ${staged ? "stage" : "unstage"} ${file}: ${(err as Error).message}`);
  }
  return getStageStates(cwd);
}
