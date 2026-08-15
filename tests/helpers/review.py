"""Fixtures shared by the annotation, report and feedback suites."""

from typing import Any

from revgate.shared.types import DiffFile, LineComment, ReviewSubmission


def make_file(path: str) -> DiffFile:
    """A changed file with no hunks — enough for renderers that only count files."""
    return DiffFile(
        old_path=path,
        new_path=path,
        path=path,
        is_new=False,
        is_deleted=False,
        is_renamed=False,
        is_binary=False,
        additions=1,
        deletions=0,
        hunks=[],
    )


def two_files() -> list[DiffFile]:
    """The two-file fixture the annotation and report tests share."""
    return [make_file("src/app.ts"), make_file("other.ts")]


def make_comment(**overrides: Any) -> LineComment:
    """A line comment on `src/app.ts:2`, with any field overridden."""
    fields: dict[str, Any] = {
        "file": "src/app.ts",
        "start_line": 2,
        "end_line": 2,
        "side": "new",
        "body": "Use const.",
    }
    fields.update(overrides)
    return LineComment(**fields)


def make_review(**overrides: Any) -> ReviewSubmission:
    """A request-changes submission with no summary and no comments, overridable."""
    fields: dict[str, Any] = {"decision": "request_changes", "summary": "", "comments": []}
    fields.update(overrides)
    return ReviewSubmission(**fields)
