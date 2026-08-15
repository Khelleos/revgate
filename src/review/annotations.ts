// The agent-readable output contract for `revgate review` — the record format is
// specified in agents.md. `report.ts` picks between the renderers below.
import { groupCommentsByFile, locationHeader } from "./feedback.js";
import type { DiffFile, ReviewSubmission } from "../shared/types.js";

/** The header facts every report carries above its records. */
export interface AnnotationMeta {
  /** Plan reviews annotate a synthetic document, not a git diff. */
  mode?: "diff" | "plan";
  /** Human-readable scope label, e.g. `main..feature` or `staged changes`. */
  scope?: string;
  branch?: string | null;
  /** Extra context for an empty review, e.g. "no changes to review". */
  note?: string;
  /** True when listing untracked files failed, so new files are missing. */
  untrackedScanFailed?: boolean;
  /** How many changed files were dropped for a line break in their path. */
  droppedPaths?: number;
}

/** Render one comment body, indented so it can never open a bogus `##` record. */
function renderBody(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return trimmed
    .split(/\r?\n/)
    .map((line, i) => (i === 0 && !line.startsWith("#") ? line : ` ${line}`));
}

/** The report for a review that produced no verdict at all. Not an APPROVED record. */
export function renderNoReview(note: string, meta: AnnotationMeta = {}): string {
  return renderNonVerdict("NO REVIEW CAPTURED", note, meta);
}

/** The shared shape of every report that carries no verdict: banner, then why. */
function renderNonVerdict(
  banner: string,
  note: string,
  meta: AnnotationMeta,
  extra: string[] = [],
): string {
  const out = [`# revgate review: ${banner}`];
  if (meta.mode === "plan") out.push("mode: plan");
  if (meta.scope) out.push(`scope: ${meta.scope}`);
  if (meta.branch) out.push(`branch: ${meta.branch}`);
  out.push(...extra);
  out.push("", note);
  return out.join("\n").trimEnd() + "\n";
}

/** The report for a scope whose `-I`/`-X` filters removed every changed file. */
export function renderNothingInScope(filteredOut: number, meta: AnnotationMeta = {}): string {
  return renderNonVerdict(
    "NOTHING IN SCOPE",
    `All ${filteredOut} changed file(s) were removed by the path filters, so nothing ` +
      `was reviewed. Check the --include/--exclude prefixes: they match paths ` +
      `relative to the repository root, not to the current directory.`,
    meta,
    [`filtered-out: ${filteredOut}`],
  );
}

/** The report for a failed untracked scan over an otherwise-empty tracked diff. */
export function renderUntrackedScanFailed(meta: AnnotationMeta = {}): string {
  return renderNonVerdict(
    "SCAN FAILED",
    `Listing untracked files failed, so any new file in this scope is missing from ` +
      `the diff — and the tracked diff was empty, leaving nothing to review. This is ` +
      `not an approval. See the stderr output for git's reason, then re-run.`,
    meta,
    ["untracked-scan: failed"],
  );
}

/** The report for a diff whose only file(s) were dropped for a line break in their path. */
export function renderDroppedPaths(dropped: number, meta: AnnotationMeta = {}): string {
  return renderNonVerdict(
    "PATHS DROPPED",
    `All ${dropped} changed file(s) were dropped because their path contains a line ` +
      `break, leaving nothing to review. A path like that would splice forged records ` +
      `into this report, so it is never rendered. This is not an approval: rename the ` +
      `file(s), then re-run.`,
    meta,
    [`dropped-paths: ${dropped}`],
  );
}

/** Render a submitted review as annotation records. Always ends with a newline. */
export function renderAnnotations(
  review: ReviewSubmission,
  files: DiffFile[],
  meta: AnnotationMeta = {},
): string {
  const out: string[] = [];

  // Leading section: the verdict is readable without parsing a single record.
  out.push(`# revgate review: ${review.decision === "approve" ? "APPROVED" : "REQUEST CHANGES"}`);
  if (meta.mode === "plan") out.push("mode: plan");
  if (meta.scope) out.push(`scope: ${meta.scope}`);
  if (meta.branch) out.push(`branch: ${meta.branch}`);
  // The same keys the non-verdict reports use, so one grep spans every kind.
  if (meta.untrackedScanFailed) out.push("untracked-scan: failed");
  if (meta.droppedPaths) out.push(`dropped-paths: ${meta.droppedPaths}`);
  out.push(`files: ${files.length}`);
  out.push(`comments: ${review.comments.length}`);
  out.push("");

  const summary = renderBody(review.summary);
  if (summary.length) out.push(...summary, "");
  if (!summary.length && !review.comments.length) {
    out.push(meta.note ?? "No comments were left.", "");
  }

  // Grouped so a file's records stay adjacent; the path is in every header
  // anyway, so this is ordering only, not structure.
  for (const [, comments] of groupCommentsByFile(review.comments)) {
    for (const c of comments) {
      out.push(`## ${locationHeader(c)}`);
      out.push(...renderBody(c.body));
      out.push("");
    }
  }

  return out.join("\n").trimEnd() + "\n";
}
