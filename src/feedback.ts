import type { DiffFile, HookDecision, LineComment, ReviewSubmission } from "./types.js";

/**
 * Group comments by file, keeping both the files and the comments within a file
 * in submission order. Shared with the annotation renderer (output.ts) so the
 * two output contracts can never disagree about ordering.
 */
export function groupCommentsByFile(comments: LineComment[]): Map<string, LineComment[]> {
  const byFile = new Map<string, LineComment[]>();
  for (const c of comments) {
    const arr = byFile.get(c.file) ?? [];
    arr.push(c);
    byFile.set(c.file, arr);
  }
  return byFile;
}

/**
 * Turn a submitted review into the HookDecision that goes back to Copilot.
 *
 * - approve         -> allow  (diff: Copilot stops · plan: Copilot proceeds)
 * - request_changes -> block  (Copilot takes another turn on `reason`)
 */
export function buildDecision(
  review: ReviewSubmission,
  files: DiffFile[],
  mode: "diff" | "plan" = "diff",
): HookDecision {
  if (review.decision === "approve") {
    return { decision: "allow" };
  }
  return { decision: "block", reason: renderPrompt(review, files, mode) };
}

/** The code lines a comment spans, in order, for quoting back to the agent. */
function rangeLines(
  files: DiffFile[],
  file: string,
  startLine: number,
  endLine: number,
  side: "new" | "old",
): string[] {
  // The display path wins outright before either side path is considered. A
  // rename plus a new file at the old name (`git mv a b` then a fresh `a`) puts
  // both in the list, and the renamed entry carries `oldPath === "a"`. Treating
  // the three keys as equal-priority let that entry match first, so a comment on
  // `a` quoted `b`'s code back to the agent under `a`'s location — a correct
  // pointer with someone else's code beneath it.
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

function renderPrompt(review: ReviewSubmission, files: DiffFile[], mode: "diff" | "plan"): string {
  const out: string[] = [];
  if (mode === "plan") {
    out.push(
      "A human reviewer looked at the plan you proposed and left the review below.",
      "Revise the plan to address every point before you start implementing, then briefly note what you changed.",
      "",
    );
  } else {
    out.push(
      "A human reviewer looked at the changes you just made and left the review below.",
      "Address every point, make the edits directly, and briefly note what you changed.",
      "",
    );
  }

  out.push("## Review verdict: REQUEST CHANGES", "");

  if (review.summary.trim()) {
    out.push("## Overall feedback", review.summary.trim(), "");
  }

  if (review.comments.length) {
    out.push(mode === "plan" ? "## Plan comments" : "## Line comments");
    // Group by file for readability.
    for (const [file, comments] of groupCommentsByFile(review.comments)) {
      out.push(`\n### ${file}`);
      for (const c of comments) {
        // `startLine < 1` is the file-level sentinel normalizeComment produces
        // for a comment with no usable line number, and which the annotation
        // renderer shows as a bare `## path`. Rendering it as `path:0` here
        // would point the agent at a line no file has, and make the two output
        // contracts disagree about a sentinel one of them introduced.
        const isFileLevel = !Number.isInteger(c.startLine) || c.startLine < 1;
        const isRange = !isFileLevel && c.endLine > c.startLine;
        const loc = isFileLevel
          ? file
          : isRange
            ? `${file}:${c.startLine}-${c.endLine}`
            : `${file}:${c.startLine}`;
        const code = isFileLevel
          ? []
          : rangeLines(files, c.file, c.startLine, c.endLine, c.side);
        if (isRange && code.length) {
          // Multiple lines read better as a fenced block than an inline ref.
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
