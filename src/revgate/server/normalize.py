"""Coercing a posted body into a verdict.

Downstream reads the fields unchecked, and a raise there reports the review as
approved — so nothing here may raise, and nothing unusable may get through.
"""

from typing import Any

from revgate.shared.jsonio import dumps_compact
from revgate.shared.log import warn
from revgate.shared.types import LineComment, ReviewSubmission


def _as_int(value: Any) -> int | None:
    """A JSON number that is a whole number, or None.

    `json.loads` gives `int` for `2` and `float` for `2.0`; a bool is neither.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def normalize_comment(entry: Any, known: set[str]) -> LineComment | None:
    """Coerce one posted entry into a well-formed LineComment, or None."""
    if not isinstance(entry, dict):
        return None
    # A comment with no file has nowhere to point.
    file = entry.get("file")
    if not isinstance(file, str) or not file:
        return None
    # Only a file in this review: an arbitrary path splices a phantom record into
    # the annotations and the feedback prompt.
    if file not in known:
        warn(f"dropped a comment on a file outside this review: {dumps_compact(file)}")
        return None

    # 0 is the file-level sentinel: an unusable number degrades, never drops.
    start = _as_int(entry.get("startLine"))
    start_line = start if start is not None and start >= 1 else 0
    end = _as_int(entry.get("endLine"))
    # endLine follows it, or the renderers disagree about which one applies.
    if start_line == 0:
        end_line = 0
    elif end is not None and end >= start_line:
        end_line = end
    else:
        end_line = start_line

    body = entry.get("body")
    return LineComment(
        file=file,
        start_line=start_line,
        end_line=end_line,
        side="old" if entry.get("side") == "old" else "new",
        body=body if isinstance(body, str) else "",
    )


def normalize_submission(body: Any, known: set[str]) -> ReviewSubmission | None:
    """Coerce a posted body into a ReviewSubmission, or None.

    The only entry point a verdict passes.
    """
    if not isinstance(body, dict):
        return None
    decision = body.get("decision")
    if decision not in ("approve", "request_changes"):
        return None

    raw_comments = body.get("comments")
    comments: list[LineComment] = []
    if isinstance(raw_comments, list):
        for entry in raw_comments:
            comment = normalize_comment(entry, known)
            if comment is not None:
                comments.append(comment)

    summary = body.get("summary")
    return ReviewSubmission(
        decision=decision,
        summary=summary if isinstance(summary, str) else "",
        comments=comments,
    )
