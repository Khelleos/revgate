"""The agent-readable record format. `location_header` has its own tests in test_feedback."""

import re

from revgate.review.annotations import (
    AnnotationMeta,
    render_annotations,
    render_dropped_paths,
    render_no_review,
    render_nothing_in_scope,
    render_untracked_scan_failed,
)
from tests.helpers.review import make_comment, make_review, two_files


def records(text: str) -> list[str]:
    """The records only — everything from the first `## ` header on, split per record."""
    lines = text.split("\n")
    start = next((i for i, line in enumerate(lines) if line.startswith("## ")), None)
    if start is None:
        return []
    body = "\n".join(lines[start:]).strip()
    return [record.strip() for record in re.split(r"\n\n(?=## )", body)]


# --- full render -----------------------------------------------------------


def test_verdict_scope_and_counts_lead_the_output() -> None:
    text = render_annotations(
        make_review(summary="Looks risky.", comments=[make_comment()]),
        two_files(),
        AnnotationMeta(mode="diff", scope="main..feature", branch="feature"),
    )
    assert text.split("\n")[:5] == [
        "# revgate review: REQUEST CHANGES",
        "scope: main..feature",
        "branch: feature",
        "files: 2",
        "comments: 1",
    ]


def test_approve_says_so_without_any_records() -> None:
    text = render_annotations(
        make_review(decision="approve"), two_files(), AnnotationMeta(scope="staged changes")
    )
    assert re.search(r"^# revgate review: APPROVED$", text, re.MULTILINE)
    assert not re.search(r"^## ", text, re.MULTILINE)
    assert "No comments were left." in text


def test_the_note_explains_an_empty_review() -> None:
    text = render_annotations(
        make_review(decision="approve"),
        [],
        AnnotationMeta(note="No changes to review in staged changes."),
    )
    assert "No changes to review in staged changes." in text
    assert re.search(r"^files: 0$", text, re.MULTILINE)


def test_plan_mode_is_flagged_in_the_header() -> None:
    text = render_annotations(
        make_review(comments=[make_comment(file="Plan")]), [], AnnotationMeta(mode="plan")
    )
    assert re.search(r"^mode: plan$", text, re.MULTILINE)


def test_one_record_per_comment_grouped_by_file() -> None:
    text = render_annotations(
        make_review(
            comments=[
                make_comment(start_line=2, end_line=2, body="Use const."),
                make_comment(
                    file="other.ts", start_line=1, end_line=1, side="old", body="Why removed?"
                ),
                make_comment(start_line=12, end_line=13, body="Extract this."),
            ]
        ),
        two_files(),
    )

    assert records(text) == [
        "## src/app.ts:2 (+)\nUse const.",
        # The third comment is on src/app.ts, so it sorts up next to the first.
        "## src/app.ts:12-13 (+)\nExtract this.",
        "## other.ts:1 (-)\nWhy removed?",
    ]


def test_continuation_lines_are_indented_so_they_cannot_open_a_record() -> None:
    text = render_annotations(
        make_review(comments=[make_comment(body="Use const.\n## not a header\nreally")]),
        two_files(),
    )
    assert records(text)[0] == "\n".join(
        ["## src/app.ts:2 (+)", "Use const.", " ## not a header", " really"]
    )
    # Exactly one record survives a body that tried to look like a header.
    assert len(records(text)) == 1


def test_a_body_whose_first_line_looks_like_a_header_is_indented_too() -> None:
    text = render_annotations(make_review(comments=[make_comment(body="## sneaky")]), two_files())
    assert records(text)[0] == "## src/app.ts:2 (+)\n ## sneaky"


def test_a_summary_that_looks_like_a_header_is_indented() -> None:
    text = render_annotations(make_review(summary="## totals\nall bad"), two_files())
    assert re.search(r"^ ## totals\n all bad$", text, re.MULTILINE)
    assert not re.search(r"^## ", text, re.MULTILINE)


def test_an_empty_comment_body_leaves_the_header_alone() -> None:
    text = render_annotations(make_review(comments=[make_comment(body="   \n ")]), two_files())
    assert records(text)[0] == "## src/app.ts:2 (+)"


def test_a_file_level_comment_has_no_line_suffix() -> None:
    text = render_annotations(
        make_review(comments=[make_comment(start_line=0, end_line=0, body="Split this file.")]),
        two_files(),
    )
    assert records(text)[0] == "## src/app.ts\nSplit this file."


def test_output_always_ends_with_exactly_one_newline() -> None:
    for review in (
        make_review(),
        make_review(comments=[make_comment()]),
        make_review(summary="hi"),
    ):
        text = render_annotations(review, two_files())
        assert text.endswith("\n"), "missing trailing newline"
        assert not text.endswith("\n\n"), "trailing blank line"


def test_an_empty_request_changes_still_reports_the_verdict() -> None:
    text = render_annotations(make_review(), two_files())
    assert re.search(r"^# revgate review: REQUEST CHANGES$", text, re.MULTILINE)
    assert re.search(r"^comments: 0$", text, re.MULTILINE)


def test_a_clean_scan_adds_no_untracked_scan_line() -> None:
    """The negative half: this line means "something is missing".

    It must never appear on an ordinary review.
    """
    text = render_annotations(make_review(summary="Fine."), two_files(), AnnotationMeta())
    assert "untracked-scan" not in text


# --- the no-verdict reports ------------------------------------------------


def test_render_no_review_reports_the_absence_of_a_verdict_never_an_approval() -> None:
    out = render_no_review(
        "No review was captured (server closed before submission).",
        AnnotationMeta(mode="diff", scope="main..feature", branch="feature"),
    )
    assert out.startswith("# revgate review: NO REVIEW CAPTURED\n")
    assert "APPROVED" not in out
    assert "scope: main..feature" in out
    assert "branch: feature" in out
    assert "server closed before submission" in out
    assert out.endswith("\n")


def test_render_untracked_scan_failed_carries_the_scope_and_branch_header_lines() -> None:
    text = render_untracked_scan_failed(
        AnnotationMeta(scope="working tree vs HEAD", branch="feature")
    )
    assert re.search(r"^# revgate review: SCAN FAILED$", text, re.MULTILINE)
    assert re.search(r"^scope: working tree vs HEAD$", text, re.MULTILINE)
    assert re.search(r"^branch: feature$", text, re.MULTILINE)
    assert re.search(r"^untracked-scan: failed$", text, re.MULTILINE)
    assert text.endswith("\n")


def test_render_dropped_paths_carries_the_scope_and_branch_header_lines() -> None:
    text = render_dropped_paths(2, AnnotationMeta(scope="main..feature", branch="feature"))
    assert re.search(r"^# revgate review: PATHS DROPPED$", text, re.MULTILINE)
    assert re.search(r"^scope: main\.\.feature$", text, re.MULTILINE)
    assert re.search(r"^branch: feature$", text, re.MULTILINE)
    assert re.search(r"^dropped-paths: 2$", text, re.MULTILINE)
    assert text.endswith("\n")


def test_render_nothing_in_scope_carries_the_header_lines() -> None:
    text = render_nothing_in_scope(1, AnnotationMeta(scope="main..feature", branch="feature"))
    assert re.search(r"^# revgate review: NOTHING IN SCOPE$", text, re.MULTILINE)
    assert re.search(r"^scope: main\.\.feature$", text, re.MULTILINE)
    assert re.search(r"^branch: feature$", text, re.MULTILINE)
    assert re.search(r"^filtered-out: 1$", text, re.MULTILINE)
    assert text.endswith("\n")
