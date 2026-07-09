import type { DiffFile, HookDecision, ReviewSubmission } from "./types.js";

/**
 * Turn a submitted review into the HookDecision that goes back to Copilot.
 *
 * - approve         -> allow  (Copilot stops; no further turn)
 * - request_changes -> block  (Copilot takes another turn on `reason`)
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
  const f = files.find((x) => x.path === file || x.newPath === file || x.oldPath === file);
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
    "A human reviewer looked at the changes you just made and left the review below.",
    "Address every point, make the edits directly, and briefly note what you changed.",
    "",
  );

  out.push("## Review verdict: REQUEST CHANGES", "");

  if (review.summary.trim()) {
    out.push("## Overall feedback", review.summary.trim(), "");
  }

  if (review.comments.length) {
    out.push("## Line comments");
    // Group by file for readability.
    const byFile = new Map<string, typeof review.comments>();
    for (const c of review.comments) {
      const arr = byFile.get(c.file) ?? [];
      arr.push(c);
      byFile.set(c.file, arr);
    }
    for (const [file, comments] of byFile) {
      out.push(`\n### ${file}`);
      for (const c of comments) {
        const isRange = c.endLine > c.startLine;
        const loc = isRange ? `${file}:${c.startLine}-${c.endLine}` : `${file}:${c.startLine}`;
        const code = rangeLines(files, c.file, c.startLine, c.endLine, c.side);
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
