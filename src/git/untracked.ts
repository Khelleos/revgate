import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { warn } from "../shared/log.js";

/** Heuristic mirroring git: a NUL byte in the first 8KB => treat as binary. */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** Largest untracked file inlined into the review; above this it is listed only. */
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;

/** Ceilings across *all* untracked files in one review; see agents.md. */
const MAX_UNTRACKED_TOTAL_BYTES = 8 * 1024 * 1024;
/** Same reasoning, for a wide tree of small files that never reaches the byte total. */
const MAX_UNTRACKED_FILES = 300;

/** Remaining allowance for one `collectDiff` call, spent by `untrackedFileDiff`. */
export interface UntrackedBudget {
  bytes: number;
  files: number;
  /** How many paths were listed unexpanded because the budget ran out. */
  elided: number;
}

/** A fresh allowance shared by every untracked file in one review. */
export function newUntrackedBudget(): UntrackedBudget {
  return { bytes: MAX_UNTRACKED_TOTAL_BYTES, files: MAX_UNTRACKED_FILES, elided: 0 };
}

/**
 * Synthesize an "all added" diff for an untracked file, which `git diff HEAD`
 * never reports. Past any budget the file is listed unexpanded, never dropped.
 */
export async function untrackedFileDiff(
  cwd: string,
  relPath: string,
  budget: UntrackedBudget,
): Promise<string> {
  const abs = path.resolve(cwd, relPath);

  // A symlink announced as a regular file lies about what a commit would add.
  const headerFor = (mode: string) =>
    `diff --git a/${relPath} b/${relPath}\n` +
    `new file mode ${mode}\n` +
    `--- /dev/null\n` +
    `+++ b/${relPath}\n`;
  const header = headerFor("100644");
  // How the UI renders "present in the review, but not expanded".
  const binaryLine = `Binary files /dev/null and b/${relPath} differ\n`;
  const unexpanded = header + binaryLine;

  let buf: Buffer;
  try {
    // Size before content, and `lstat` before the budget: the budget decides
    // whether a path is *expanded*, never what it *is*. See agents.md.
    const info = await lstat(abs);
    const isLink = info.isSymbolicLink();
    if (budget.files <= 0) {
      budget.elided++;
      return headerFor(isLink ? "120000" : "100644") + binaryLine;
    }
    if (isLink) {
      // A link's `lstat` size is its target's length, which is what gets inlined.
      budget.bytes -= info.size;
      budget.files--;
      const target = await readlink(abs);
      // The target becomes diff content, so a line break in it splices a record.
      if (/[\r\n]/.test(target)) {
        warn(
          `untracked symlink ${relPath} points at a path containing a newline — ` +
            `listing it without a diff`,
        );
        return headerFor("120000") + binaryLine;
      }
      // Exactly what `git diff` emits for a new symlink.
      return (
        headerFor("120000") + `@@ -0,0 +1 @@\n+${target}\n\\ No newline at end of file\n`
      );
    }
    if (!info.isFile()) {
      // A FIFO, socket or device node: `readFile` on one blocks or never ends.
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
    // Charged before the checks below: the read already cost the memory.
    budget.bytes -= info.size;
    budget.files--;
  } catch (err) {
    // Listed unexpanded, never dropped: a file that leaves the review is one the
    // reviewer approved without seeing.
    warn(`could not read untracked file ${relPath}: ${(err as Error).message}`);
    return unexpanded;
  }

  if (looksBinary(buf)) {
    return unexpanded;
  }

  const text = buf.toString("utf8");
  // Split, dropping the trailing empty element from a final newline.
  const rawLines = text.split("\n");
  if (rawLines.length && rawLines[rawLines.length - 1] === "") rawLines.pop();
  if (rawLines.length === 0) return header; // empty new file — nothing to show

  const hunk = `@@ -0,0 +1,${rawLines.length} @@\n`;
  const body = rawLines.map((l) => `+${l}`).join("\n") + "\n";
  const noNewlineAtEof = !text.endsWith("\n");
  return header + hunk + body + (noNewlineAtEof ? "\\ No newline at end of file\n" : "");
}
