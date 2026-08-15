"""The shared location format, and the block prompt the plan hook feeds back to the agent."""

import re
from typing import Any

from revgate.review.feedback import build_decision, is_file_level_comment, location_header
from revgate.shared.types import DiffFile, DiffHunk, DiffLine, LineComment, ReviewSubmission

APP_FILE = DiffFile(
    old_path="src/app.ts",
    new_path="src/app.ts",
    path="src/app.ts",
    is_new=False,
    is_deleted=False,
    is_renamed=False,
    is_binary=False,
    additions=3,
    deletions=0,
    hunks=[
        DiffHunk(
            header="@@ -1,1 +1,2 @@",
            old_start=1,
            new_start=1,
            lines=[
                DiffLine(type="context", content='import a from "a";', old_line=1, new_line=1),
                DiffLine(type="add", content="let x = 1;", old_line=None, new_line=2),
            ],
        ),
        DiffHunk(
            header="@@ -11,0 +12,2 @@",
            old_start=11,
            new_start=12,
            lines=[
                DiffLine(
                    type="add", content="  const big = compute();", old_line=None, new_line=12
                ),
                DiffLine(type="add", content="  return big;", old_line=None, new_line=13),
            ],
        ),
    ],
)

OTHER_FILE = DiffFile(
    old_path="other.ts",
    new_path="other.ts",
    path="other.ts",
    is_new=False,
    is_deleted=False,
    is_renamed=False,
    is_binary=False,
    additions=0,
    deletions=1,
    hunks=[
        DiffHunk(
            header="@@ -1 +0,0 @@",
            old_start=1,
            new_start=1,
            lines=[DiffLine(type="del", content="const gone = true;", old_line=1, new_line=None)],
        )
    ],
)

FILES = [APP_FILE, OTHER_FILE]


def review(**overrides: Any) -> ReviewSubmission:
    fields: dict[str, Any] = {"decision": "request_changes", "summary": "", "comments": []}
    fields.update(overrides)
    return ReviewSubmission(**fields)


def comment(**overrides: Any) -> LineComment:
    fields: dict[str, Any] = {
        "file": "src/app.ts",
        "start_line": 2,
        "end_line": 2,
        "side": "new",
        "body": "Use const.",
    }
    fields.update(overrides)
    return LineComment(**fields)


# --- shared location format ------------------------------------------------
# Both output contracts render a comment's location through `location_header`,
# so a change here moves the annotation records and the hook prose together.


def test_location_header_single_line_on_the_new_side() -> None:
    assert location_header(comment()) == "src/app.ts:2 (+)"


def test_location_header_single_line_on_the_old_side() -> None:
    assert location_header(comment(side="old")) == "src/app.ts:2 (-)"


def test_location_header_a_range_keeps_both_endpoints() -> None:
    assert location_header(comment(start_line=12, end_line=13)) == "src/app.ts:12-13 (+)"
    assert location_header(comment(start_line=4, end_line=9, side="old")) == "src/app.ts:4-9 (-)"


def test_location_header_no_usable_line_number_is_a_file_level_record() -> None:
    assert location_header(comment(start_line=0, end_line=0)) == "src/app.ts"
    assert location_header(comment(start_line=-1, end_line=-1)) == "src/app.ts"
    assert location_header(comment(start_line=float("nan"), end_line=float("nan"))) == "src/app.ts"


def test_only_an_unusable_line_number_is_file_level() -> None:
    assert is_file_level_comment(comment()) is False
    assert is_file_level_comment(comment(start_line=1, end_line=1)) is False
    assert is_file_level_comment(comment(start_line=0, end_line=0)) is True
    assert is_file_level_comment(comment(start_line=-1, end_line=-1)) is True
    # Out-of-contract values: only `json.loads` can produce these, and a
    # fractional or NaN line is not a line any file has.
    assert is_file_level_comment(comment(start_line=float("nan"), end_line=float("nan"))) is True
    assert is_file_level_comment(comment(start_line=1.5, end_line=1.5)) is True


def test_build_decision_approve_allows_with_no_reason() -> None:
    decision = build_decision(review(decision="approve", summary="ship it"), FILES)
    assert decision.decision == "allow"
    assert decision.reason is None


def test_build_decision_request_changes_renders_the_full_block_prompt() -> None:
    """Snapshot of the exact block prompt the plan hook feeds back to the agent."""
    decision = build_decision(
        review(
            summary="Looks risky.",
            comments=[
                LineComment(
                    file="src/app.ts", start_line=2, end_line=2, side="new", body="Use const."
                ),
                LineComment(
                    file="src/app.ts",
                    start_line=12,
                    end_line=13,
                    side="new",
                    body="Extract this.\nSeriously.",
                ),
                LineComment(
                    file="other.ts", start_line=1, end_line=1, side="old", body="Why removed?"
                ),
            ],
        ),
        FILES,
    )

    assert decision.decision == "block"
    assert decision.reason == "\n".join(
        [
            "A human reviewer looked at the plan you proposed and left the review below.",
            "Revise the plan to address every point before you start implementing, "
            "then briefly note what you changed.",
            "",
            "## Review verdict: REQUEST CHANGES",
            "",
            "## Overall summary",
            "Looks risky.",
            "",
            "## Plan comments",
            "",
            "### src/app.ts",
            "- **src/app.ts:2 (+)**  (`let x = 1;`)",
            "  Use const.",
            "- **src/app.ts:12-13 (+)**",
            "  ```",
            "    const big = compute();",
            "    return big;",
            "  ```",
            "  Extract this.",
            "  Seriously.",
            "",
            "### other.ts",
            "- **other.ts:1 (-)**  (`const gone = true;`)",
            "  Why removed?",
            "",
        ]
    )


def test_a_single_line_comment_quotes_the_line_inline() -> None:
    decision = build_decision(
        review(
            comments=[
                LineComment(file="src/app.ts", start_line=2, end_line=2, side="new", body="No.")
            ]
        ),
        FILES,
    )
    reason = decision.reason or ""
    assert re.search(r"^- \*\*src/app\.ts:2 \(\+\)\*\* {2}\(`let x = 1;`\)$", reason, re.MULTILINE)
    assert "```" not in reason


def test_a_range_comment_quotes_the_lines_as_a_fenced_block() -> None:
    decision = build_decision(
        review(
            comments=[
                LineComment(file="src/app.ts", start_line=12, end_line=13, side="new", body="No.")
            ]
        ),
        FILES,
    )
    assert re.search(
        r"- \*\*src/app\.ts:12-13 \(\+\)\*\*\n {2}```\n {4}const big = compute\(\);\n",
        decision.reason or "",
    )


def test_an_old_side_comment_resolves_against_deleted_lines() -> None:
    decision = build_decision(
        review(
            comments=[
                LineComment(file="other.ts", start_line=1, end_line=1, side="old", body="Why?")
            ]
        ),
        FILES,
    )
    assert re.search(
        r"- \*\*other\.ts:1 \(-\)\*\* {2}\(`const gone = true;`\)", decision.reason or ""
    )


def test_an_old_side_location_is_marked_as_one() -> None:
    """The quoted code always came from the right side, but the location string was not.

    A comment on a deleted line reached the agent as a bare `other.ts:1`, which
    reads as line 1 of the file on disk. The agent would go there, find
    something else, and have an accurate quote filed under a location pointing
    somewhere it never was.
    """
    decision = build_decision(
        review(
            comments=[
                LineComment(file="other.ts", start_line=1, end_line=1, side="old", body="Why?")
            ]
        ),
        FILES,
    )
    reason = decision.reason or ""
    assert not re.search(r"\*\*other\.ts:1\*\*", reason)
    assert "(-)" in reason


def test_a_comment_on_an_unknown_file_omits_the_code_reference() -> None:
    decision = build_decision(
        review(
            comments=[
                LineComment(file="missing.ts", start_line=5, end_line=5, side="new", body="Hmm.")
            ]
        ),
        FILES,
    )
    assert re.search(r"^- \*\*missing\.ts:5 \(\+\)\*\*$", decision.reason or "", re.MULTILINE)


def test_an_empty_request_changes_falls_back_to_an_ask_the_human_prompt() -> None:
    decision = build_decision(review(), FILES)
    assert decision.reason == "\n".join(
        [
            "A human reviewer looked at the plan you proposed and left the review below.",
            "Revise the plan to address every point before you start implementing, "
            "then briefly note what you changed.",
            "",
            "## Review verdict: REQUEST CHANGES",
            "",
            "The reviewer requested changes but left no specific notes. Ask them what to change.",
        ]
    )


def test_a_whitespace_only_summary_counts_as_empty() -> None:
    decision = build_decision(review(summary="   \n  "), FILES)
    reason = decision.reason or ""
    assert "## Overall summary" not in reason
    assert "left no specific notes" in reason


def test_a_summary_with_comments_skips_the_fallback_line() -> None:
    decision = build_decision(
        review(
            summary="Fix it.",
            comments=[
                LineComment(file="src/app.ts", start_line=2, end_line=2, side="new", body="here")
            ],
        ),
        FILES,
    )
    assert "left no specific notes" not in (decision.reason or "")


def test_a_file_level_comment_is_not_quoted_back_as_line_zero() -> None:
    """`normalize_comment` degrades an unusable line number to 0.

    That is the file-level sentinel the annotation renderer shows as a bare
    `## path`. Rendering it as `src/app.ts:0` here would point the agent at a
    line no file has, and make the two output contracts disagree about a
    sentinel one of them introduced.
    """
    decision = build_decision(
        review(
            summary="",
            comments=[
                LineComment(
                    file="src/app.ts", start_line=0, end_line=0, side="new", body="Whole file."
                )
            ],
        ),
        FILES,
    )
    reason = decision.reason or ""
    assert re.search(r"^- \*\*src/app\.ts\*\*$", reason, re.MULTILINE)
    assert "src/app.ts:0" not in reason
    assert re.search(r"^ {2}Whole file\.$", reason, re.MULTILINE)


def test_a_rename_does_not_steal_a_comment_on_a_new_file_at_the_old_path() -> None:
    """`git mv a.txt b.txt` plus a fresh `a.txt` puts both in the diff.

    The renamed entry still carries `old_path: "a.txt"`. Matching
    path/new_path/old_path at equal priority resolved a comment on `a.txt` to
    the RENAMED file, so the agent read a correct location with a different
    file's code quoted under it.
    """
    renamed = DiffFile(
        old_path="a.txt",
        new_path="b.txt",
        path="b.txt",
        is_new=False,
        is_deleted=False,
        is_renamed=True,
        is_binary=False,
        additions=1,
        deletions=0,
        hunks=[
            DiffHunk(
                header="@@ -1 +1 @@",
                old_start=1,
                new_start=1,
                lines=[DiffLine(type="add", content="moved content", old_line=None, new_line=1)],
            )
        ],
    )
    recreated = DiffFile(
        old_path="/dev/null",
        new_path="a.txt",
        path="a.txt",
        is_new=True,
        is_deleted=False,
        is_renamed=False,
        is_binary=False,
        additions=1,
        deletions=0,
        hunks=[
            DiffHunk(
                header="@@ -0,0 +1 @@",
                old_start=0,
                new_start=1,
                lines=[
                    DiffLine(type="add", content="brand new content", old_line=None, new_line=1)
                ],
            )
        ],
    )

    decision = build_decision(
        review(
            summary="",
            comments=[
                LineComment(file="a.txt", start_line=1, end_line=1, side="new", body="Check this.")
            ],
        ),
        # Renamed entry first, so a first-match-wins lookup picks the wrong one.
        [renamed, recreated],
    )
    reason = decision.reason or ""
    assert "brand new content" in reason
    assert "moved content" not in reason
