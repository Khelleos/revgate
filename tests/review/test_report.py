"""Which report gets rendered, and with what exit code.

The one decision an agent must never see wrong: whether a human approved.
`revgate review` owns several mutually exclusive reports, and the choice between
them lives here as a pure function so it can be tested directly.
"""

import re

from revgate.review.report import (
    ReviewOutcomeSummary,
    has_findings,
    review_exit_code,
    review_report,
)
from tests.helpers.review import make_comment, make_review, two_files

# --- exit codes ------------------------------------------------------------


def test_has_findings_counts_comments_or_a_request_changes_verdict() -> None:
    assert has_findings(make_review(decision="approve")) is False
    assert has_findings(make_review(decision="approve", comments=[make_comment()])) is True
    assert has_findings(make_review()) is True
    assert has_findings(make_review(comments=[make_comment()])) is True


def test_exit_code_10_only_when_opted_in_and_something_was_captured() -> None:
    assert review_exit_code(make_review(decision="approve"), True) == 0
    assert review_exit_code(make_review(), True) == 10
    assert review_exit_code(make_review(decision="approve", comments=[make_comment()]), True) == 10
    # Without the flag a review that found problems still exits 0.
    assert review_exit_code(make_review(), False) == 0
    assert review_exit_code(make_review(decision="approve"), False) == 0


# --- review_report ---------------------------------------------------------


def test_an_interrupted_review_is_exit_1_and_never_an_approval() -> None:
    report = review_report(
        ReviewOutcomeSummary(
            review=None,
            files=two_files(),
            interrupted=True,
            is_repo=True,
            note="No review was captured (x).",
            scope="main..feature",
        ),
        "diff",
        False,
    )
    assert report.kind == "interrupted"
    assert report.exit_code == 1, "exit 0 would read as a human sign-off nobody gave"
    assert re.search(r"^# revgate review: NO REVIEW CAPTURED$", report.text, re.MULTILINE)
    assert "APPROVED" not in report.text
    assert "No review was captured" in report.text


def test_interrupted_wins_over_every_other_signal() -> None:
    """An interrupted run outside a repo must still report "no verdict"."""
    report = review_report(
        ReviewOutcomeSummary(review=None, files=[], interrupted=True, is_repo=False), "diff", True
    )
    assert report.kind == "interrupted"
    assert report.exit_code == 1


def test_outside_a_repository_with_no_verdict_is_exit_2_not_an_approval() -> None:
    report = review_report(
        ReviewOutcomeSummary(review=None, files=[], is_repo=False), "diff", False
    )
    assert report.kind == "not-a-repo"
    assert report.exit_code == 2, "a wrong directory is bad usage, not an approval"
    assert re.search(r"^# revgate review: NO REVIEW CAPTURED$", report.text, re.MULTILINE)
    assert "Not a git repository" in report.text


def test_outside_a_repository_with_a_verdict_reports_the_verdict() -> None:
    """A plan review opens the UI outside a repo, so a human can reach submit there.

    Discarding what they typed is the same "report disagrees with the reviewer"
    failure, inverted.
    """
    report = review_report(
        ReviewOutcomeSummary(review=make_review(summary="Please fix."), files=[], is_repo=False),
        "plan",
        False,
    )
    assert report.kind == "verdict"
    assert report.exit_code == 0
    assert re.search(r"^# revgate review: REQUEST CHANGES$", report.text, re.MULTILINE)
    assert "Please fix." in report.text
    assert "NO REVIEW CAPTURED" not in report.text


def test_nothing_to_review_is_a_real_approval_at_exit_0() -> None:
    report = review_report(
        ReviewOutcomeSummary(
            review=None,
            files=[],
            is_repo=True,
            note="No changes to review in main..feature.",
            scope="main..feature",
        ),
        "diff",
        True,
    )
    assert report.kind == "verdict"
    assert report.exit_code == 0, "--exit-code-on-comments must not fire on an empty review"
    assert re.search(r"^# revgate review: APPROVED$", report.text, re.MULTILINE)
    assert "No changes to review in main..feature." in report.text


def test_a_captured_verdict_honours_exit_code_on_comments() -> None:
    def captured() -> ReviewOutcomeSummary:
        return ReviewOutcomeSummary(
            review=make_review(comments=[make_comment()]), files=two_files(), is_repo=True
        )

    assert review_report(captured(), "diff", True).exit_code == 10
    assert review_report(captured(), "diff", False).exit_code == 0
    assert review_report(captured(), "diff", True).kind == "verdict"


def test_filters_that_removed_every_file_are_exit_2_not_an_approval() -> None:
    """The dangerous inversion this branch exists for.

    A busy diff, an -I/-X pair that hid all of it, and a report the agent reads
    as a clean bill of health.
    """
    report = review_report(
        ReviewOutcomeSummary(
            review=None,
            files=[],
            is_repo=True,
            filtered_out=3,
            note="No changes to review.",
            scope="working tree vs HEAD [+no-such-dir]",
        ),
        "diff",
        True,
    )
    assert report.kind == "filtered-out"
    assert report.exit_code == 2, "hiding the whole diff is bad usage, not an approval"
    assert re.search(r"^# revgate review: NOTHING IN SCOPE$", report.text, re.MULTILINE)
    assert "APPROVED" not in report.text
    assert re.search(r"^filtered-out: 3$", report.text, re.MULTILINE)
    assert re.search(r"^scope: working tree vs HEAD \[\+no-such-dir\]$", report.text, re.MULTILINE)
    # The fix the caller has to make is named in the report, not only on stderr:
    # with -o <file> the report is the only thing an agent reads.
    assert "relative to the repository root" in report.text


def test_a_verdict_beats_filtered_out() -> None:
    """A plan review opens the UI on an empty file list.

    A human can submit on a run that also filtered everything out, and what they
    typed wins — as with is_repo.
    """
    report = review_report(
        ReviewOutcomeSummary(
            review=make_review(summary="Looks fine."), files=[], is_repo=True, filtered_out=2
        ),
        "diff",
        False,
    )
    assert report.kind == "verdict"
    assert report.exit_code == 0
    assert "NOTHING IN SCOPE" not in report.text


def test_an_empty_diff_with_no_filters_stays_an_approval() -> None:
    """`filtered_out: 0` must not read as "filters emptied it".

    A clean tree is a real "approve, nothing to act on".
    """
    report = review_report(
        ReviewOutcomeSummary(review=None, files=[], is_repo=True, filtered_out=0), "diff", False
    )
    assert report.kind == "verdict"
    assert report.exit_code == 0
    assert re.search(r"^# revgate review: APPROVED$", report.text, re.MULTILINE)


def test_a_failed_untracked_scan_over_an_empty_diff_is_exit_2() -> None:
    """`ls-files` failed, so every new file is missing from the diff.

    A turn whose whole output is new files then looks exactly like a clean tree,
    and APPROVED/0 there is a sign-off on code nobody was shown.
    """
    report = review_report(
        ReviewOutcomeSummary(
            review=None,
            files=[],
            is_repo=True,
            untracked_scan_failed=True,
            note="No changes to review.",
            scope="working tree vs HEAD",
        ),
        "diff",
        True,
    )
    assert report.kind == "scan-failed"
    assert report.exit_code == 2
    assert re.search(r"^# revgate review: SCAN FAILED$", report.text, re.MULTILINE)
    assert "APPROVED" not in report.text
    assert re.search(r"^untracked-scan: failed$", report.text, re.MULTILINE)
    # With -o <file> the report is all an agent reads, so it has to say so itself.
    assert "not an approval" in report.text


def test_a_verdict_beats_a_failed_untracked_scan() -> None:
    """A human who looked at the tracked files and submitted still gets their decision.

    But it is still said out loud: the verdict covers the files that reached the
    diff, and without the header line an APPROVED report is indistinguishable
    from one over a complete diff.
    """
    report = review_report(
        ReviewOutcomeSummary(
            review=make_review(summary="Fine."),
            files=two_files(),
            is_repo=True,
            untracked_scan_failed=True,
        ),
        "diff",
        False,
    )
    assert report.kind == "verdict"
    assert report.exit_code == 0
    assert "SCAN FAILED" not in report.text
    assert re.search(r"^untracked-scan: failed$", report.text, re.MULTILINE)


def test_a_diff_emptied_by_dropped_paths_is_not_an_approval() -> None:
    """The parser drops a file whose path carries a line break.

    If it was the only change, the file list is empty — and an empty file list
    otherwise reads as "nothing to review, approve", a clean bill of health for
    code nobody saw.
    """
    report = review_report(
        ReviewOutcomeSummary(
            review=None,
            files=[],
            is_repo=True,
            dropped_paths=1,
            note="No changes to review.",
            scope="working tree vs HEAD",
        ),
        "diff",
        True,
    )
    assert report.kind == "dropped-paths"
    assert report.exit_code == 2
    assert re.search(r"^# revgate review: PATHS DROPPED$", report.text, re.MULTILINE)
    assert "APPROVED" not in report.text
    assert re.search(r"^dropped-paths: 1$", report.text, re.MULTILINE)
    assert "not an approval" in report.text


def test_a_dropped_path_alongside_reviewed_files_is_a_header_line_not_a_report() -> None:
    """Something WAS reviewed here, so the verdict stands.

    The report just has to say it does not cover everything that changed.
    """
    report = review_report(
        ReviewOutcomeSummary(
            review=make_review(summary="Fine."), files=two_files(), is_repo=True, dropped_paths=1
        ),
        "diff",
        False,
    )
    assert report.kind == "verdict"
    assert report.exit_code == 0
    assert re.search(r"^dropped-paths: 1$", report.text, re.MULTILINE)


def test_no_dropped_paths_line_when_nothing_was_dropped() -> None:
    report = review_report(
        ReviewOutcomeSummary(review=make_review(summary="Fine."), files=two_files(), is_repo=True),
        "diff",
        False,
    )
    assert "dropped-paths" not in report.text
