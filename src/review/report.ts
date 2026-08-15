// The renderers live in `annotations.ts`; this module owns the *choice* between
// them, because picking the wrong one forges a verdict.
import {
  renderAnnotations,
  renderDroppedPaths,
  renderNoReview,
  renderNothingInScope,
  renderUntrackedScanFailed,
  type AnnotationMeta,
} from "./annotations.js";
import type { DiffFile, ReviewSubmission } from "../shared/types.js";

/** True when the review carries something the agent has to act on. */
export function hasFindings(review: ReviewSubmission): boolean {
  return review.decision === "request_changes" || review.comments.length > 0;
}

/** The exit code for a completed review. `10` only with `--exit-code-on-comments`. */
export function reviewExitCode(review: ReviewSubmission, exitCodeOnComments: boolean): number {
  return exitCodeOnComments && hasFindings(review) ? 10 : 0;
}

/** What a completed `revgate review` reports, and why. */
export interface ReviewReport {
  /** Why this report reads the way it does; only "verdict" carries a decision. */
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
  /** Null when nothing was submitted: nothing to review, or interrupted. */
  review: ReviewSubmission | null;
  files: DiffFile[];
  /** Scope label and branch for the annotation header. */
  scope?: string;
  branch?: string | null;
  /** True only when a review was opened and then lost before a submission. */
  interrupted?: boolean;
  /** False only when the diff scope resolved outside a git repository. */
  isRepo?: boolean;
  note?: string;
  /** How many files the `-I`/`-X` filters removed, when they removed every one. */
  filteredOut?: number;
  /** True when the untracked scan failed, so new files are missing from the diff. */
  untrackedScanFailed?: boolean;
  /** How many changed files were dropped for a line break in their path. */
  droppedPaths?: number;
}

/**
 * Decide what `revgate review` prints and exits with. Pure, because getting it
 * wrong forges a verdict — see the verdict rule in agents.md.
 */
export function reviewReport(
  outcome: ReviewOutcomeSummary,
  mode: "diff" | "plan",
  exitCodeOnComments: boolean,
): ReviewReport {
  // Every header fact comes off the one outcome, so no caller can hand this
  // function two disagreeing copies of the same review.
  const meta: AnnotationMeta = {
    mode,
    scope: outcome.scope,
    branch: outcome.branch,
    note: outcome.note,
    untrackedScanFailed: outcome.untrackedScanFailed,
    droppedPaths: outcome.droppedPaths,
  };
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
  // The three branches below need there to be no verdict: discarding a decision
  // a human just typed is the same inversion, the other way round.
  if (!outcome.review && (outcome.filteredOut ?? 0) > 0) {
    return {
      kind: "filtered-out",
      text: renderNothingInScope(outcome.filteredOut as number, meta),
      exitCode: 2,
    };
  }
  if (!outcome.review && outcome.untrackedScanFailed) {
    return {
      kind: "scan-failed",
      text: renderUntrackedScanFailed(meta),
      exitCode: 2,
    };
  }
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
    // A verdict does not make missing files reappear: `meta` still carries
    // `untrackedScanFailed`/`droppedPaths` for the header.
    text: renderAnnotations(review, outcome.files, meta),
    exitCode: reviewExitCode(review, exitCodeOnComments),
  };
}
