import type { DiffFile, DiffHunk, DiffLine } from "./types.js";

/**
 * Minimal unified-diff parser tuned for `git diff` output. Zero dependencies
 * on purpose so the hook launches fast and installs cleanly. Handles new /
 * deleted / renamed / binary files and standard @@ hunks.
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const lines = text.split("\n");
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLineNo = 0;
  let newLineNo = 0;

  const stripPrefix = (p: string): string => {
    if (p === "/dev/null") return p;
    if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
    return p;
  };

  const pushFile = (): void => {
    if (current) files.push(current);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      pushFile();
      hunk = null;
      // "diff --git a/x b/x" — fall back to these paths until ---/+++ refine them.
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const guess = m ? m[2] : "";
      current = {
        oldPath: m ? m[1] : "",
        newPath: guess,
        path: guess,
        isNew: false,
        isDeleted: false,
        isRenamed: false,
        isBinary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      continue;
    }

    if (!current) continue;

    if (line.startsWith("new file mode")) {
      current.isNew = true;
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.isDeleted = true;
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.isRenamed = true;
      current.oldPath = line.slice("rename from ".length).trim();
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.isRenamed = true;
      current.newPath = line.slice("rename to ".length).trim();
      current.path = current.newPath;
      continue;
    }
    if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
      current.isBinary = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      const p = stripPrefix(line.slice(4).trim());
      current.oldPath = p;
      if (p === "/dev/null") current.isNew = true;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = stripPrefix(line.slice(4).trim());
      current.newPath = p;
      if (p === "/dev/null") current.isDeleted = true;
      else current.path = p;
      continue;
    }

    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      oldLineNo = m ? parseInt(m[1], 10) : 0;
      newLineNo = m ? parseInt(m[2], 10) : 0;
      hunk = {
        header: line,
        oldStart: oldLineNo,
        newStart: newLineNo,
        lines: [],
      };
      current.hunks.push(hunk);
      continue;
    }

    if (!hunk) continue;

    if (line.startsWith("\\")) {
      // "\ No newline at end of file" — attach to nothing, just skip.
      continue;
    }

    const tag = line[0];
    const content = line.slice(1);
    let entry: DiffLine | null = null;
    if (tag === "+") {
      entry = { type: "add", content, oldLine: null, newLine: newLineNo++ };
      current.additions++;
    } else if (tag === "-") {
      entry = { type: "del", content, oldLine: oldLineNo++, newLine: null };
      current.deletions++;
    } else if (tag === " " || line === "") {
      entry = { type: "context", content, oldLine: oldLineNo++, newLine: newLineNo++ };
    }
    if (entry) hunk.lines.push(entry);
  }

  pushFile();
  return files;
}
