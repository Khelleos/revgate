import type { DiffFile, HookDecision, LineComment, ReviewSubmission } from "../shared/types.js";

/** Group comments by file, in submission order. Shared, so both contracts order alike. */
export function groupCommentsByFile(comments: LineComment[]): Map<string, LineComment[]> {
  const byFile = new Map<string, LineComment[]>();
  for (const c of comments) {
    const arr = byFile.get(c.file) ?? [];
    arr.push(c);
    byFile.set(c.file, arr);
  }
  return byFile;
}

/** True for the file-level sentinel `normalizeComment` produces. */
export function isFileLevelComment(c: LineComment): boolean {
  return !Number.isInteger(c.startLine) || c.startLine < 1;
}

/**
 * Where a comment points, in the form BOTH contracts render: `path:LINE (+)` on
 * the new side, `(-)` on the old, a bare `path` when file-level. Shared, because
 * a diff has two line numberings and the marker is what tells them apart.
 */
export function locationHeader(c: LineComment): string {
  if (isFileLevelComment(c)) return c.file;
  const marker = c.side === "old" ? "(-)" : "(+)";
  const span = c.endLine > c.startLine ? `${c.startLine}-${c.endLine}` : `${c.startLine}`;
  return `${c.file}:${span} ${marker}`;
}

/**
 * The HookDecision for a submitted plan review: approve -> allow,
 * request_changes -> block with the feedback prompt. Plan reviews only.
 */
export function buildDecision(review: ReviewSubmission, files: DiffFile[]): HookDecision {
  if (review.decision === "approve") {
    return { decision: "allow" };
  }
  return { decision: "block", reason: renderPrompt(review, files) };
}

/** The code lines a comment spans, in order, for quoting back to the agent. */
function rangeLines(
  files: DiffFile[],
  file: string,
  startLine: number,
  endLine: number,
  side: "new" | "old",
): string[] {
  // The display path wins: `git mv a b` plus a fresh `a` puts both in the list,
  // and an equal-priority match would quote `b`'s code under `a`.
  const f =
    files.find((x) => x.path === file) ??
    files.find((x) => x.newPath === file || x.oldPath === file);
  if (!f) return [];
  const out: string[] = [];
  for (const h of f.hunks) {
    for (const l of h.lines) {
      const n = side === "new" ? l.newLine : l.oldLine;
      if (n != null && n >= startLine && n <= endLine) out.push(l.content);
    }
  }
  return out;
}

function renderPrompt(review: ReviewSubmission, files: DiffFile[]): string {
  const out: string[] = [];
  out.push(
    "A human reviewer looked at the plan you proposed and left the review below.",
    "Revise the plan to address every point before you start implementing, then briefly note what you changed.",
    "",
  );

  out.push("## Review verdict: REQUEST CHANGES", "");

  if (review.summary.trim()) {
    out.push("## Overall feedback", review.summary.trim(), "");
  }

  if (review.comments.length) {
    out.push("## Plan comments");
    for (const [file, comments] of groupCommentsByFile(review.comments)) {
      out.push(`\n### ${file}`);
      for (const c of comments) {
        // The location comes from the shared renderer, so this prose and the
        // annotation records describe the same comment the same way.
        const isFileLevel = isFileLevelComment(c);
        const isRange = !isFileLevel && c.endLine > c.startLine;
        const loc = locationHeader(c);
        const code = isFileLevel
          ? []
          : rangeLines(files, c.file, c.startLine, c.endLine, c.side);
        if (isRange && code.length) {
          out.push(`- **${loc}**`, "  ```");
          for (const cl of code) out.push(`  ${cl}`);
          out.push("  ```");
        } else {
          const codeRef = code.length ? `  (\`${code[0].trim()}\`)` : "";
          out.push(`- **${loc}**${codeRef}`);
        }
        for (const bl of c.body.trim().split("\n")) {
          out.push(`  ${bl}`);
        }
      }
    }
    out.push("");
  }

  if (!review.summary.trim() && review.comments.length === 0) {
    out.push("The reviewer requested changes but left no specific notes. Ask them what to change.");
  }

  return out.join("\n");
}
