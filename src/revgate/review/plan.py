"""Modelling a proposed plan as a synthetic diff, so one review pipeline serves both."""

import re

from revgate.shared.types import DiffFile, DiffHunk, DiffLine

_HEADING_RE = re.compile(r"^#{1,2}\s+(.+)")


def plan_to_files(plan_text: str) -> list[DiffFile]:
    """Model a plan as a synthetic single-file "diff".

    Every plan line becomes a commentable line numbered from 1 on the "new" side.
    """
    # `\Z`, not `$`: Python's `$` also matches before a final newline, and the
    # trailing-whitespace strip has to be anchored at the true end of the text.
    normalized = re.sub(r"\s+\Z", "", plan_text.replace("\r\n", "\n"))
    lines = normalized.split("\n") if normalized else [""]
    return [
        DiffFile(
            old_path="",
            new_path="PLAN",
            path="Plan",
            is_new=False,
            is_deleted=False,
            is_renamed=False,
            is_binary=False,
            additions=0,
            deletions=0,
            hunks=[
                DiffHunk(
                    header="",
                    old_start=0,
                    new_start=1,
                    lines=[
                        DiffLine(type="plan", content=content, old_line=None, new_line=number)
                        for number, content in enumerate(lines, start=1)
                    ],
                )
            ],
        )
    ]


def plan_title(plan_text: str) -> str:
    """The first markdown H1/H2 as a short title, else a generic label."""
    for line in plan_text.split("\n"):
        match = _HEADING_RE.match(line)
        if match:
            return match.group(1).strip()
    return "Proposed plan"
