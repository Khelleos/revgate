import { warn } from "../shared/log.js";
import type { DiffFile, DiffHunk, DiffLine } from "../shared/types.js";

/** The C escapes git emits in a quoted path, mapped to the byte they stand for. */
const C_ESCAPES: Record<string, number> = {
  a: 0x07, b: 0x08, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b, '"': 0x22, "\\": 0x5c,
};

/**
 * Decode the body of a git-quoted path (the text between the double quotes).
 * The escapes are `\NNN` *octal bytes*, so they are collected into a buffer and
 * decoded as UTF-8 in one go: a single `é` arrives as `\303\251`.
 */
export function unquoteGitPath(quoted: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < quoted.length; i++) {
    const ch = quoted[i];
    if (ch !== "\\") {
      // Re-encode: the escapes above are bytes, so everything must be bytes.
      for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
      continue;
    }
    const next = quoted[++i];
    if (next === undefined) break; // trailing backslash — nothing to escape
    if (next >= "0" && next <= "7" && /^[0-7]{3}$/.test(quoted.slice(i, i + 3))) {
      bytes.push(parseInt(quoted.slice(i, i + 3), 8));
      i += 2;
      continue;
    }
    const known = C_ESCAPES[next];
    if (known !== undefined) bytes.push(known);
    else for (const b of Buffer.from(next, "utf8")) bytes.push(b); // unknown: keep it
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Undo git's path quoting if the token carries it; otherwise pass it through. */
function unquoteIfQuoted(p: string): string {
  return p.length >= 2 && p.startsWith('"') && p.endsWith('"')
    ? unquoteGitPath(p.slice(1, -1))
    : p;
}

/**
 * True if any of a file's paths carries a line break. Everything downstream is
 * line-oriented, so such a path splices phantom records — see the path-splicing
 * rule in agents.md.
 */
function hasLineBreakInPath(f: DiffFile): boolean {
  return /[\r\n]/.test(f.path) || /[\r\n]/.test(f.oldPath) || /[\r\n]/.test(f.newPath);
}

/**
 * Minimal unified-diff parser tuned for `git diff` output. Zero dependencies on
 * purpose, so the hook launches fast and installs cleanly. Handles new, deleted,
 * renamed and binary files and standard `@@` hunks. `onDrop` receives each file
 * refused for an unsafe path.
 */
export function parseUnifiedDiff(text: string, onDrop?: (file: DiffFile) => void): DiffFile[] {
  const lines = text.split("\n");
  // A trailing newline leaves a final empty element. It is not a context line:
  // taking it as one appends a blank row numbered one past the end of the file.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLineNo = 0;
  let newLineNo = 0;

  const stripPrefix = (p: string): string => {
    if (p === "/dev/null") return p;
    // Unquote BEFORE stripping: git quotes the whole token including the `a/`
    // prefix (`"a/caf\303\251.txt"`), so a quoted path does not start with `a/`.
    const s = unquoteIfQuoted(p);
    if (s.startsWith("a/") || s.startsWith("b/")) return s.slice(2);
    return s;
  };

  const pushFile = (): void => {
    if (!current) return;
    if (hasLineBreakInPath(current)) {
      warn(`skipping file whose name contains a newline: ${JSON.stringify(current.path)}`);
      // Dropped, but not silently: if it was the only change, an empty diff
      // reads downstream as "nothing to review, approve".
      onDrop?.(current);
      return;
    }
    files.push(current);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      pushFile();
      hunk = null;
      // Fall back to the header's own paths until ---/+++ refine them. The
      // backreference keeps the two quote states independent, since a rename can
      // quote one path and not the other; the `\r` strip keeps a CRLF line ending
      // out of the guessed path, where it would trip the line-break guard.
      const m = line.replace(/\r+$/, "").match(/^diff --git ("?)a\/(.+?)\1 ("?)b\/(.+)\3$/);
      const guess = m ? (m[3] ? unquoteGitPath(m[4]) : m[4]) : "";
      current = {
        oldPath: m ? (m[1] ? unquoteGitPath(m[2]) : m[2]) : "",
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
      // Quoted like the header paths, but with no `a/`/`b/` prefix.
      current.oldPath = unquoteIfQuoted(line.slice("rename from ".length).trim());
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.isRenamed = true;
      current.newPath = unquoteIfQuoted(line.slice("rename to ".length).trim());
      current.path = current.newPath;
      continue;
    }
    if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
      current.isBinary = true;
      continue;
    }
    // Both header branches are gated on being OUTSIDE a hunk: inside one, a
    // deleted `-- ` line arrives as `--- …` and an added `++ ` line as `+++ …`,
    // and swallowing either as a path header renumbers the side and overwrites
    // `path`. git emits `---`/`+++` before the first `@@`, so `hunk === null`
    // admits exactly the real headers.
    if (!hunk && line.startsWith("--- ")) {
      const p = stripPrefix(line.slice(4).trim());
      current.oldPath = p;
      if (p === "/dev/null") current.isNew = true;
      continue;
    }
    if (!hunk && line.startsWith("+++ ")) {
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
      continue; // "\ No newline at end of file" — attaches to nothing
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
