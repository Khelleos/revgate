"""Choosing which report to render.

The renderers live in `annotations.py`; this module owns the *choice* between
them, because picking the wrong one forges a verdict.
"""

from dataclasses import dataclass, field
from typing import Literal

from revgate.review.annotations import (
    AnnotationMeta,
    render_annotations,
    render_dropped_paths,
    render_no_review,
    render_nothing_in_scope,
    render_untracked_scan_failed,
)
from revgate.shared.types import DiffFile, ReviewSubmission

ReportKind = Literal[
    "interrupted", "not-a-repo", "filtered-out", "scan-failed", "dropped-paths", "verdict"
]


def has_findings(review: ReviewSubmission) -> bool:
    """True when the review carries something the agent has to act on."""
    return review.decision == "request_changes" or len(review.comments) > 0


def review_exit_code(review: ReviewSubmission, exit_code_on_comments: bool) -> int:
    """The exit code for a completed review. `10` only with `--exit-code-on-comments`."""
    return 10 if exit_code_on_comments and has_findings(review) else 0


@dataclass(slots=True)
class ReviewReport:
    """What a completed `revgate review` reports, and why."""

    #: Why this report reads the way it does; only "verdict" carries a decision.
    kind: ReportKind
    #: The report to deliver, to stdout or `--output`.
    text: str
    exit_code: int


@dataclass(slots=True)
class ReviewOutcomeSummary:
    """The outcome of one review, reduced to what the report depends on."""

    #: None when nothing was submitted: nothing to review, or interrupted.
    review: ReviewSubmission | None = None
    files: list[DiffFile] = field(default_factory=list)
    #: Scope label and branch for the annotation header.
    scope: str | None = None
    branch: str | None = None
    #: True only when a review was opened and then lost before a submission.
    interrupted: bool = False
    #: False only when the diff scope resolved outside a git repository.
    is_repo: bool = True
    note: str | None = None
    #: How many files the `-I`/`-X` filters removed, when they removed every one.
    filtered_out: int = 0
    #: True when the untracked scan failed, so new files are missing from the diff.
    untracked_scan_failed: bool = False
    #: How many changed files were dropped for a line break in their path.
    dropped_paths: int = 0


def review_report(
    outcome: ReviewOutcomeSummary, mode: Literal["diff", "plan"], exit_code_on_comments: bool
) -> ReviewReport:
    """Decide what `revgate review` prints and exits with.

    Pure, because getting it wrong forges a verdict — see the verdict rule in
    agents.md.
    """
    # Every header fact comes off the one outcome, so no caller can hand this
    # function two disagreeing copies of the same review.
    meta = AnnotationMeta(
        mode=mode,
        scope=outcome.scope,
        branch=outcome.branch,
        note=outcome.note,
        untracked_scan_failed=outcome.untracked_scan_failed,
        dropped_paths=outcome.dropped_paths,
    )
    if outcome.interrupted:
        return ReviewReport(
            kind="interrupted",
            text=render_no_review(
                outcome.note if outcome.note is not None else "The review was interrupted.", meta
            ),
            exit_code=1,
        )
    if outcome.is_repo is False and outcome.review is None:
        return ReviewReport(
            kind="not-a-repo",
            text=render_no_review(
                outcome.note
                if outcome.note is not None
                else "Not a git repository — no diff available.",
                meta,
            ),
            exit_code=2,
        )
    # The three branches below need there to be no verdict: discarding a decision
    # a human just typed is the same inversion, the other way round.
    if outcome.review is None and outcome.filtered_out > 0:
        return ReviewReport(
            kind="filtered-out",
            text=render_nothing_in_scope(outcome.filtered_out, meta),
            exit_code=2,
        )
    if outcome.review is None and outcome.untracked_scan_failed:
        return ReviewReport(
            kind="scan-failed", text=render_untracked_scan_failed(meta), exit_code=2
        )
    if outcome.review is None and outcome.dropped_paths > 0 and not outcome.files:
        return ReviewReport(
            kind="dropped-paths",
            text=render_dropped_paths(outcome.dropped_paths, meta),
            exit_code=2,
        )
    review = outcome.review or ReviewSubmission(decision="approve", summary="", comments=[])
    return ReviewReport(
        kind="verdict",
        # A verdict does not make missing files reappear: `meta` still carries
        # `untracked_scan_failed`/`dropped_paths` for the header.
        text=render_annotations(review, outcome.files, meta),
        exit_code=review_exit_code(review, exit_code_on_comments),
    )
