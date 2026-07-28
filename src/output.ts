/**
 * The agent-readable output contract for `revgate review`.
 *
 * Hooks speak JSON (see feedback.ts / index.ts); a skill-driven review speaks
 * markdown *annotations* instead, mirroring revdiff's record format:
 *
 *     # revgate review: REQUEST CHANGES
 *     scope: main..feature
 *     files: 2
 *     comments: 1
 *
 *     Overall this needs another pass.
 *
 *     ## src/app.ts:12-13 (+)
 *     Extract this.
 *      It is duplicated below.
 *
 * Each `## ` line is a record header naming an exact location; everything
 * beneath it up to the next header is that comment's body. Continuation lines
 * are prefixed with one space so a body can never be mistaken for a header.
 */
import { groupCommentsByFile } from "./feedback.js";
import type { DiffFile, LineComment, ReviewSubmission } from "./types.js";

export interface AnnotationMeta {
  /** Plan reviews annotate a synthetic document, not a git diff. */
  mode?: "diff" | "plan";
  /** Human-readable scope label, e.g. `main..feature` or `staged changes`. */
  scope?: string;
  branch?: string | null;
  /** Extra context for an empty review, e.g. "no changes to review". */
  note?: string;
  /**
   * True when listing untracked files failed, so new files are missing from the
   * reviewed diff. Rendered as a header line on a *verdict* report — the report
   * for the no-verdict case is `renderUntrackedScanFailed`.
   */
  untrackedScanFailed?: boolean;
  /**
   * How many changed files the parser dropped for carrying a line break in their
   * path. Same treatment as `untrackedScanFailed`: a header line on a *verdict*
   * report, and `renderDroppedPaths` when there is no verdict at all.
   */
  droppedPaths?: number;
}

/**
 * Render one comment body.
 *
 * The first line stays flush so the record reads naturally; every following
 * line gets a leading space. A first line that itself starts with `#` is
 * indented too — otherwise a body could open a bogus record.
 */
function renderBody(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return trimmed
    .split(/\r?\n/)
    .map((line, i) => (i === 0 && !line.startsWith("#") ? line : ` ${line}`));
}

/**
 * The location half of a record header. A comment with no usable line number
 * is file-level (`## path`); otherwise `## path:LINE (+)`, `## path:LINE (-)`
 * for the old side, or `## path:START-END (+)` for a range.
 */
export function locationHeader(c: LineComment): string {
  if (!Number.isInteger(c.startLine) || c.startLine < 1) return c.file;
  const marker = c.side === "old" ? "(-)" : "(+)";
  const span = c.endLine > c.startLine ? `${c.startLine}-${c.endLine}` : `${c.startLine}`;
  return `${c.file}:${span} ${marker}`;
}

/** True when the review carries something the agent has to act on. */
export function hasFindings(review: ReviewSubmission): boolean {
  return review.decision === "request_changes" || review.comments.length > 0;
}

/**
 * The exit code for a completed `revgate review`.
 *
 * `10` (revdiff's signal for "comments were captured") only when the caller
 * opted in with `--exit-code-on-comments`; 1 and 2 stay reserved for real
 * errors, so a review that simply found problems is never confused with a crash.
 */
export function reviewExitCode(review: ReviewSubmission, exitCodeOnComments: boolean): number {
  return exitCodeOnComments && hasFindings(review) ? 10 : 0;
}

/**
 * Render the report for a review that never produced a verdict — the server
 * closed or errored before anything was submitted.
 *
 * Deliberately NOT an APPROVED record. An interrupted review is the *absence*
 * of a human decision, and rendering it as an approval would forge exactly the
 * verdict this command exists to capture. The verdict line says so, and the
 * caller pairs it with a non-zero exit so the agent can't read it as a go-ahead.
 */
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

/**
 * Render the report for a scope whose `-I`/`-X` filters removed every changed
 * file.
 *
 * Also deliberately NOT an APPROVED record, for the same reason as
 * `renderNoReview`: nobody looked at anything. An empty *diff* is a real
 * "approve, nothing to act on", but an empty *filter result* means the diff was
 * busy and the invocation asked for none of it — almost always a mistyped or
 * wrongly-anchored prefix. Reporting that as APPROVED/0 hands the agent a clean
 * bill of health for code no reviewer ever saw, and with `-o <file>` the report is
 * all the agent reads, so a stderr warning does not reach it.
 */
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

/**
 * Render the report for a scope whose untracked-file scan failed and whose
 * tracked diff was empty.
 *
 * Also deliberately NOT an APPROVED record, for the reason in `renderNoReview`
 * and `renderNothingInScope`: the diff came back empty because the scan that
 * would have found the new files failed, not because the tree is clean. A turn
 * whose entire output is new files is the common case, and APPROVED/0 there is a
 * clean bill of health for code no reviewer ever saw. With `-o <file>` the report
 * is all the agent reads, so the stderr warning does not reach it.
 */
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

/**
 * Render the report for a diff whose only changed file(s) were dropped for
 * carrying a line break in their path.
 *
 * Also deliberately NOT an APPROVED record, for the reason in
 * `renderUntrackedScanFailed`: the diff came back empty because the files in it
 * could not be rendered safely, not because the tree is clean. Only stderr said
 * so, and with `-o <file>` the report is all the agent reads.
 */
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

/** What a completed `revgate review` reports, and why. */
export interface ReviewReport {
  /**
   * - "interrupted"  — a review was opened and lost before any verdict arrived
   * - "not-a-repo"   — the diff scope resolved outside a git repository
   * - "filtered-out" — the `-I`/`-X` filters removed every changed file
   * - "scan-failed"  — listing untracked files failed and the tracked diff was empty
   * - "dropped-paths" — every changed file was dropped for a line break in its path
   * - "verdict"      — a real verdict (including "nothing to review, so approve")
   */
  kind:
    | "interrupted"
    | "not-a-repo"
    | "filtered-out"
    | "scan-failed"
    | "dropped-paths"
    | "verdict";
  /** The report to deliver, to stdout or `--output`. */
  text: string;
  exitCode: number;
}

/** The outcome of one review, reduced to what the report depends on. */
export interface ReviewOutcomeSummary {
  /** Null when no review was submitted — nothing to review, or interrupted. */
  review: ReviewSubmission | null;
  files: DiffFile[];
  /** True only when a review was opened and then lost before a submission. */
  interrupted?: boolean;
  /** False only when the diff scope resolved outside a git repository. */
  isRepo?: boolean;
  /** Why there is no review, when there isn't one. */
  note?: string;
  /**
   * How many changed files the `-I`/`-X` filters removed, when they removed ALL
   * of them and no review was opened. Absent (or 0) whenever the empty file list
   * is the diff's own doing — the two are the same *decision* for a hook but not
   * the same *report*: see `renderNothingInScope`.
   */
  filteredOut?: number;
  /**
   * True when the untracked scan failed, so new files are missing from the diff.
   * With no review it produces a SCAN FAILED report (see
   * `renderUntrackedScanFailed`); with one it becomes an `untracked-scan: failed`
   * header line, because a verdict on a diff that silently omitted every new
   * file is not a verdict on the turn's changes.
   */
  untrackedScanFailed?: boolean;
  /**
   * How many changed files the parser dropped for a line break in their path.
   * With no review and no file left it produces a PATHS DROPPED report (see
   * `renderDroppedPaths`); with one it becomes a `dropped-paths:` header line,
   * because a verdict on a diff a changed file never reached is not a verdict on
   * all of them.
   */
  droppedPaths?: number;
}

/**
 * Decide what `revgate review` prints and exits with. Pure, because getting this
 * wrong forges a verdict:
 *
 * - An interrupted review is the *absence* of a decision. Reporting it as
 *   APPROVED/0 would hand the agent a human sign-off nobody gave, so it is exit 1
 *   (a real error) — while the hook paths keep allowing, since wedging the agent
 *   on our own failure is the worse trade there.
 * - Running outside a repository is an environment error, not "nothing to
 *   review": exit 2 so the agent fixes the invocation rather than reading an
 *   approval. Only when no verdict exists, though — `--demo` opens the UI outside
 *   a repo too, and discarding a verdict a human just typed is the same
 *   "the report disagrees with the reviewer" failure, inverted.
 * - Filters that removed every changed file are bad usage, not "nothing to
 *   review": exit 2, so the caller fixes its prefixes instead of banking an
 *   approval of a diff it hid from the reviewer.
 * - A failed untracked scan over an otherwise-empty diff is an environment error,
 *   not "nothing to review": exit 2, for the same reason — the files that would
 *   have filled the diff are the ones the scan failed to find.
 * - Nothing to review IS a real "approve, nothing to act on".
 */
export function reviewReport(
  outcome: ReviewOutcomeSummary,
  meta: AnnotationMeta,
  exitCodeOnComments: boolean,
): ReviewReport {
  if (outcome.interrupted) {
    return {
      kind: "interrupted",
      text: renderNoReview(outcome.note ?? "The review was interrupted.", meta),
      exitCode: 1,
    };
  }
  if (outcome.isRepo === false && !outcome.review) {
    return {
      kind: "not-a-repo",
      text: renderNoReview(outcome.note ?? "Not a git repository — no diff available.", meta),
      exitCode: 2,
    };
  }
  // Only when no verdict exists: `--demo` opens the UI on an empty file list too,
  // and discarding a decision a human just typed is its own inversion.
  if (!outcome.review && (outcome.filteredOut ?? 0) > 0) {
    return {
      kind: "filtered-out",
      text: renderNothingInScope(outcome.filteredOut as number, meta),
      exitCode: 2,
    };
  }
  // Same "only when no verdict exists" rule: a human who reviewed the tracked
  // files and submitted still gets their decision reported.
  if (!outcome.review && outcome.untrackedScanFailed) {
    return {
      kind: "scan-failed",
      text: renderUntrackedScanFailed(meta),
      exitCode: 2,
    };
  }
  // Same rule again: an empty diff whose only file(s) were dropped for an unsafe
  // path is not "nothing to review", and APPROVED/0 there is a clean bill of
  // health for code nobody saw.
  if (!outcome.review && (outcome.droppedPaths ?? 0) > 0 && outcome.files.length === 0) {
    return {
      kind: "dropped-paths",
      text: renderDroppedPaths(outcome.droppedPaths as number, meta),
      exitCode: 2,
    };
  }
  const review: ReviewSubmission = outcome.review ?? {
    decision: "approve",
    summary: "",
    comments: [],
  };
  return {
    kind: "verdict",
    // `note` explains an empty review ("No changes to review in main..feature."),
    // and it is the same note the two branches above render. Falling back to the
    // outcome's own copy keeps a caller from setting one and not the other.
    text: renderAnnotations(review, outcome.files, {
      ...meta,
      note: meta.note ?? outcome.note,
      // A verdict does not make the missing files reappear: the human reviewed
      // the tracked half and the agent has to know that is all this covers.
      untrackedScanFailed: meta.untrackedScanFailed ?? outcome.untrackedScanFailed,
      // Same reasoning: the dropped file is still missing from what was reviewed.
      droppedPaths: meta.droppedPaths ?? outcome.droppedPaths,
    }),
    exitCode: reviewExitCode(review, exitCodeOnComments),
  };
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
  // Same key the SCAN FAILED report uses, so one grep answers "was anything
  // missing from this review?" across every report kind.
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

  // Grouped by file so a file's records stay adjacent; the path is repeated in
  // every header anyway, so grouping is ordering only, not structure.
  for (const [, comments] of groupCommentsByFile(review.comments)) {
    for (const c of comments) {
      out.push(`## ${locationHeader(c)}`);
      out.push(...renderBody(c.body));
      out.push("");
    }
  }

  return out.join("\n").trimEnd() + "\n";
}
