"""The agent-readable output contract for `revgate review`.

The record format is specified in agents.md. `report.py` picks between the
renderers below.
"""

import re
from dataclasses import dataclass
from typing import Literal

from revgate.review.feedback import group_comments_by_file, location_header
from revgate.shared.types import DiffFile, ReviewSubmission

_NEWLINE_RE = re.compile(r"\r?\n")


@dataclass(slots=True)
class AnnotationMeta:
    """The header facts every report carries above its records."""

    #: Plan reviews annotate a synthetic document, not a git diff.
    mode: Literal["diff", "plan"] | None = None
    #: Human-readable scope label, e.g. `main..feature` or `staged changes`.
    scope: str | None = None
    branch: str | None = None
    #: Extra context for an empty review, e.g. "no changes to review".
    note: str | None = None
    #: True when listing untracked files failed, so new files are missing.
    untracked_scan_failed: bool = False
    #: How many changed files were dropped for a line break in their path.
    dropped_paths: int = 0


def _render_body(text: str) -> list[str]:
    """Render one comment body, indented so it can never open a bogus `##` record."""
    trimmed = text.strip()
    if not trimmed:
        return []
    return [
        line if index == 0 and not line.startswith("#") else f" {line}"
        for index, line in enumerate(_NEWLINE_RE.split(trimmed))
    ]


def _render_non_verdict(
    banner: str, note: str, meta: AnnotationMeta, extra: list[str] | None = None
) -> str:
    """The shared shape of every report that carries no verdict: banner, then why."""
    out = [f"# revgate review: {banner}"]
    if meta.mode == "plan":
        out.append("mode: plan")
    if meta.scope:
        out.append(f"scope: {meta.scope}")
    if meta.branch:
        out.append(f"branch: {meta.branch}")
    out += extra or []
    out += ["", note]
    return "\n".join(out).rstrip() + "\n"


def render_no_review(note: str, meta: AnnotationMeta | None = None) -> str:
    """The report for a review that produced no verdict at all. Not an APPROVED record."""
    return _render_non_verdict("NO REVIEW CAPTURED", note, meta or AnnotationMeta())


def render_nothing_in_scope(filtered_out: int, meta: AnnotationMeta | None = None) -> str:
    """The report for a scope whose `-I`/`-X` filters removed every changed file."""
    return _render_non_verdict(
        "NOTHING IN SCOPE",
        f"All {filtered_out} changed file(s) were removed by the path filters, so nothing "
        f"was reviewed. Check the --include/--exclude prefixes: they match paths "
        f"relative to the repository root, not to the current directory.",
        meta or AnnotationMeta(),
        [f"filtered-out: {filtered_out}"],
    )


def render_untracked_scan_failed(meta: AnnotationMeta | None = None) -> str:
    """The report for a failed untracked scan over an otherwise-empty tracked diff."""
    return _render_non_verdict(
        "SCAN FAILED",
        "Listing untracked files failed, so any new file in this scope is missing from "
        "the diff — and the tracked diff was empty, leaving nothing to review. This is "
        "not an approval. See the stderr output for git's reason, then re-run.",
        meta or AnnotationMeta(),
        ["untracked-scan: failed"],
    )


def render_dropped_paths(dropped: int, meta: AnnotationMeta | None = None) -> str:
    """The report for a diff whose only file(s) were dropped for a line break in their path."""
    return _render_non_verdict(
        "PATHS DROPPED",
        f"All {dropped} changed file(s) were dropped because their path contains a line "
        f"break, leaving nothing to review. A path like that would splice forged records "
        f"into this report, so it is never rendered. This is not an approval: rename the "
        f"file(s), then re-run.",
        meta or AnnotationMeta(),
        [f"dropped-paths: {dropped}"],
    )


def render_annotations(
    review: ReviewSubmission, files: list[DiffFile], meta: AnnotationMeta | None = None
) -> str:
    """Render a submitted review as annotation records. Always ends with a newline."""
    meta = meta or AnnotationMeta()
    out: list[str] = []

    # Leading section: the verdict is readable without parsing a single record.
    verdict = "APPROVED" if review.decision == "approve" else "REQUEST CHANGES"
    out.append(f"# revgate review: {verdict}")
    if meta.mode == "plan":
        out.append("mode: plan")
    if meta.scope:
        out.append(f"scope: {meta.scope}")
    if meta.branch:
        out.append(f"branch: {meta.branch}")
    # The same keys the non-verdict reports use, so one grep spans every kind.
    if meta.untracked_scan_failed:
        out.append("untracked-scan: failed")
    if meta.dropped_paths:
        out.append(f"dropped-paths: {meta.dropped_paths}")
    out.append(f"files: {len(files)}")
    out.append(f"comments: {len(review.comments)}")
    out.append("")

    summary = _render_body(review.summary)
    if summary:
        out += [*summary, ""]
    if not summary and not review.comments:
        out += [meta.note if meta.note is not None else "No comments were left.", ""]

    # Grouped so a file's records stay adjacent; the path is in every header
    # anyway, so this is ordering only, not structure.
    for comments in group_comments_by_file(review.comments).values():
        for comment in comments:
            out.append(f"## {location_header(comment)}")
            out += _render_body(comment.body)
            out.append("")

    return "\n".join(out).rstrip() + "\n"
