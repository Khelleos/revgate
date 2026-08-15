"""A plan modelled as a synthetic diff, and the title lifted off its first heading."""

import pytest

from revgate.review.plan import plan_title, plan_to_files
from revgate.shared.types import DiffLine


def plan_lines(text: str) -> list[DiffLine]:
    return plan_to_files(text)[0].hunks[0].lines


def test_plan_to_files_produces_one_synthetic_file_with_plan_metadata() -> None:
    files = plan_to_files("step one\nstep two")
    assert len(files) == 1
    plan = files[0]
    assert plan.path == "Plan"
    assert plan.new_path == "PLAN"
    assert plan.old_path == ""
    assert plan.is_new is False
    assert plan.is_deleted is False
    assert plan.is_renamed is False
    assert plan.is_binary is False
    assert plan.additions == 0
    assert plan.deletions == 0
    assert len(plan.hunks) == 1
    assert plan.hunks[0].header == ""
    assert plan.hunks[0].old_start == 0
    assert plan.hunks[0].new_start == 1


def test_plan_to_files_numbers_every_line_from_one_on_the_new_side() -> None:
    assert [
        (line.type, line.content, line.old_line, line.new_line)
        for line in plan_lines("alpha\nbeta\ngamma")
    ] == [
        ("plan", "alpha", None, 1),
        ("plan", "beta", None, 2),
        ("plan", "gamma", None, 3),
    ]


def test_plan_to_files_normalizes_crlf() -> None:
    assert [line.content for line in plan_lines("alpha\r\nbeta\r\ngamma")] == [
        "alpha",
        "beta",
        "gamma",
    ]


def test_plan_to_files_strips_trailing_whitespace_and_blank_lines() -> None:
    assert [line.content for line in plan_lines("alpha\nbeta\n\n\n  ")] == ["alpha", "beta"]
    assert [line.content for line in plan_lines("alpha\r\nbeta\r\n")] == ["alpha", "beta"]


def test_plan_to_files_keeps_interior_blank_lines_commentable() -> None:
    assert [(line.content, line.new_line) for line in plan_lines("alpha\n\nbeta")] == [
        ("alpha", 1),
        ("", 2),
        ("beta", 3),
    ]


@pytest.mark.parametrize("empty", ["", "   ", "\n\n"])
def test_an_empty_plan_still_yields_one_commentable_line(empty: str) -> None:
    assert [(line.content, line.new_line) for line in plan_lines(empty)] == [("", 1)]


def test_plan_title_uses_the_first_h1() -> None:
    assert plan_title("# Rewrite the parser\n\nbody text") == "Rewrite the parser"


def test_plan_title_uses_an_h2_when_there_is_no_h1() -> None:
    assert plan_title("intro\n\n## Phase one\n\n# Later heading") == "Phase one"


def test_plan_title_trims_surrounding_whitespace_and_crlf() -> None:
    assert plan_title("#   Spaced title  \nbody") == "Spaced title"
    assert plan_title("# CRLF title\r\nbody") == "CRLF title"


def test_plan_title_ignores_h3_and_deeper() -> None:
    assert plan_title("### Too deep\n#### Deeper") == "Proposed plan"


def test_plan_title_ignores_a_hash_with_no_space() -> None:
    assert plan_title("#NoSpace\nbody") == "Proposed plan"


def test_plan_title_falls_back_to_a_generic_label() -> None:
    assert plan_title("just some prose\nand more") == "Proposed plan"
    assert plan_title("") == "Proposed plan"
