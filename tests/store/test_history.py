"""Archiving a review as markdown. `save_history` never raises: that is its contract."""

import json
import re
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest

from revgate.shared.types import LineComment, ReviewSubmission
from revgate.store.history import (
    HistoryDocumentContext,
    HistoryMeta,
    history_root,
    render_history_document,
    repo_segment,
    sanitize_segment,
    save_history,
    timestamp_name,
)
from tests.helpers.repo import RepoFactory, TempRepo, init_repo
from tests.helpers.review import make_file

AT = datetime(2026, 7, 29, 15, 30, 0, 123_000, tzinfo=UTC)


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


def review(**overrides: Any) -> ReviewSubmission:
    fields: dict[str, Any] = {
        "decision": "request_changes",
        "summary": "Needs another pass.",
        "comments": [comment()],
    }
    fields.update(overrides)
    return ReviewSubmission(**fields)


def tree(root: Path) -> list[str]:
    """Every file written under `root`, as POSIX paths relative to it."""
    return sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file())


def real_top(repo: TempRepo) -> str:
    """git resolves symlinked temp dirs (macOS /var -> /private/var); follow suit."""
    return repo.git("rev-parse", "--show-toplevel").strip()


def frontmatter(document: str) -> list[str]:
    """The lines between the two `---` fences."""
    return re.split(r"^---$", document, flags=re.MULTILINE)[1].strip().split("\n")


# --- directory resolution --------------------------------------------------


def test_history_root_precedence(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """--history-dir beats the env var, which beats ~/.revgate."""
    monkeypatch.delenv("REVGATE_HISTORY_DIR", raising=False)
    assert history_root() == Path.home() / ".revgate" / "history"
    assert history_root("   ") == Path.home() / ".revgate" / "history"

    monkeypatch.setenv("REVGATE_HISTORY_DIR", str(tmp_path / "from-env"))
    assert history_root() == tmp_path / "from-env"
    assert history_root(str(tmp_path / "from-flag")) == tmp_path / "from-flag"


def test_a_relative_history_directory_resolves_against_the_cwd(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("REVGATE_HISTORY_DIR", raising=False)
    assert history_root("reviews") == Path("reviews").absolute()


# --- name sanitization -----------------------------------------------------


def test_sanitize_segment_keeps_safe_names_and_collapses_everything_else() -> None:
    assert sanitize_segment("revgate") == "revgate"
    assert sanitize_segment("my.repo-2_x") == "my.repo-2_x"
    assert sanitize_segment("my repo") == "my-repo"
    assert sanitize_segment("a/b\\c") == "a-b-c"
    assert sanitize_segment("weird:*?name") == "weird-name"
    assert sanitize_segment("  spaced  ") == "spaced"


def test_a_name_that_could_escape_the_directory_cannot() -> None:
    assert sanitize_segment("..") == "no-repo"
    assert sanitize_segment(".") == "no-repo"
    assert sanitize_segment("../../etc") == "etc"
    assert sanitize_segment("") == "no-repo"
    assert sanitize_segment("///") == "no-repo"


def test_timestamp_name_is_an_iso_stamp_with_no_path_hostile_characters() -> None:
    assert timestamp_name(AT) == "2026-07-29T15-30-00-123Z.md"
    assert not re.search(r'[:*?"<>|]', timestamp_name(AT))


def test_the_timestamp_keeps_exactly_three_fractional_digits() -> None:
    """`datetime.isoformat()` gives six digits and `+00:00`; the stamp is a contract."""
    assert timestamp_name(datetime(2026, 1, 2, 3, 4, 5, 6, tzinfo=UTC)) == (
        "2026-01-02T03-04-05-000Z.md"
    )
    assert timestamp_name(datetime(2026, 1, 2, 3, 4, 5, 987_654, tzinfo=UTC)) == (
        "2026-01-02T03-04-05-987Z.md"
    )


# --- repo name -------------------------------------------------------------


def test_repo_segment_is_the_git_toplevel_basename_inside_a_repo(
    make_repo: RepoFactory,
) -> None:
    repo = make_repo({"a.txt": "one\n"})

    expected = sanitize_segment(Path(real_top(repo)).name)
    assert repo_segment(repo.path) == expected
    # A subdirectory still reports the toplevel, not itself.
    repo.write("nested/b.txt", "two\n")
    assert repo_segment(str(repo.dir / "nested")) == expected


def test_repo_segment_is_no_repo_outside_a_repository(tmp_path: Path) -> None:
    assert repo_segment(str(tmp_path)) == "no-repo"


# --- document format -------------------------------------------------------


def test_frontmatter_records_scope_branch_session_and_time() -> None:
    document = render_history_document(
        review(),
        [make_file("src/app.ts")],
        HistoryDocumentContext(
            date=AT,
            repo="revgate",
            session_id="abc123",
            scope="main..feature",
            branch="feature",
            mode="diff",
        ),
    )

    # Values are double-quoted: they are free text (a scope label can contain a
    # colon), and an unquoted one would make the whole block unparseable YAML.
    assert frontmatter(document) == [
        "date: 2026-07-29T15:30:00.123Z",
        'repo: "revgate"',
        "mode: diff",
        'session: "abc123"',
        'scope: "main..feature"',
        'branch: "feature"',
    ]
    # The body is the annotation format, unchanged.
    body = re.split(r"^---$", document, flags=re.MULTILINE)[2]
    assert re.search(r"^# revgate review: REQUEST CHANGES$", body, re.MULTILINE)
    assert re.search(r"^## src/app\.ts:2 \(\+\)\nUse const\.$", body, re.MULTILINE)
    assert document.endswith("\n")


def test_a_failed_untracked_scan_survives_into_the_archive() -> None:
    """History is where a review whose live output was lost gets re-read.

    Dropping this line there makes the recovered copy read as a complete review
    of the turn, when every new file was in fact missing from the diff.
    """
    document = render_history_document(
        review(),
        [make_file("src/app.ts")],
        HistoryDocumentContext(
            date=AT,
            repo="revgate",
            scope="working tree vs HEAD",
            mode="diff",
            untracked_scan_failed=True,
        ),
    )
    assert re.search(r"^untracked-scan: failed$", document, re.MULTILINE)


def test_optional_fields_are_omitted_not_left_blank() -> None:
    document = render_history_document(
        review(), [], HistoryDocumentContext(date=AT, repo="no-repo", mode="plan")
    )
    assert re.search(r"^mode: plan$", document, re.MULTILINE)
    assert not re.search(r"^session:", document, re.MULTILINE)
    assert not re.search(r"^scope:", document, re.MULTILINE)
    assert not re.search(r"^branch:", document, re.MULTILINE)


def test_a_plan_scope_containing_colons_stays_parseable_frontmatter() -> None:
    """A plan review's scope is `plan: <the plan's own H1>`.

    Titles like "Plan: add rate limiting" are the norm. Unquoted, this emits
    `scope: plan: Plan: add rate limiting` — a YAML syntax error that corrupts
    the header of every plan review ever archived.
    """
    document = render_history_document(
        review(),
        [make_file("Plan")],
        HistoryDocumentContext(
            date=AT,
            repo="revgate",
            scope="plan: Plan: add rate limiting to the public API",
            mode="plan",
        ),
    )

    front = frontmatter(document)
    scope_line = next(line for line in front if line.startswith("scope:"))
    assert scope_line == 'scope: "plan: Plan: add rate limiting to the public API"'

    # Every line is still one flat `key: value` pair whose value round-trips.
    for line in front:
        match = re.match(r"^([a-z]+): (.*)$", line)
        assert match, f"not a flat key: value pair — {line!r}"
        if match.group(2).startswith('"'):
            json.loads(match.group(2))


def test_a_quote_in_a_value_is_escaped_not_left_to_break_the_block() -> None:
    document = render_history_document(
        review(),
        [make_file("Plan")],
        HistoryDocumentContext(
            date=AT, repo="revgate", branch='feat/"odd"-name', scope="line1\nline2"
        ),
    )
    front = frontmatter(document)
    assert next(line for line in front if line.startswith("branch:")) == (
        'branch: "feat/\\"odd\\"-name"'
    )
    # A newline in a value must not become a second frontmatter line:
    # date, repo, mode, scope, branch — and nothing a value smuggled in.
    assert len(front) == 5, "a value's newline leaked into the frontmatter block"
    assert next(line for line in front if line.startswith("scope:")) == 'scope: "line1\\nline2"'


# --- saving ----------------------------------------------------------------


def test_save_history_writes_dir_repo_timestamp_md(make_repo: RepoFactory, tmp_path: Path) -> None:
    repo = make_repo({"a.txt": "one\n"})
    root = tmp_path / "history"

    destination = save_history(
        review(),
        [make_file("src/app.ts")],
        HistoryMeta(
            cwd=repo.path,
            session_id="s1",
            scope="staged changes",
            branch="main",
            history_dir=str(root),
            now=AT,
        ),
    )

    assert destination, "expected a file to be written"
    name = sanitize_segment(Path(real_top(repo)).name)
    assert destination == str(root / name / "2026-07-29T15-30-00-123Z.md")
    assert tree(root) == [f"{name}/2026-07-29T15-30-00-123Z.md"]

    content = Path(destination).read_text(encoding="utf-8")
    assert re.search(r'^session: "s1"$', content, re.MULTILINE)
    assert re.search(r'^scope: "staged changes"$', content, re.MULTILINE)
    assert re.search(r"^## src/app\.ts:2 \(\+\)$", content, re.MULTILINE)


def test_the_archived_copy_carries_untracked_scan_failed(tmp_path: Path) -> None:
    destination = save_history(
        review(),
        [make_file("src/app.ts")],
        HistoryMeta(
            cwd=str(tmp_path),
            scope="working tree vs HEAD",
            mode="diff",
            untracked_scan_failed=True,
            history_dir=str(tmp_path / "history"),
            now=AT,
        ),
    )
    assert destination, "expected the review to be archived"
    content = Path(destination).read_text(encoding="utf-8")
    assert re.search(r"^untracked-scan: failed$", content, re.MULTILINE)


def test_the_archived_copy_carries_dropped_paths(tmp_path: Path) -> None:
    """Same argument as untracked-scan.

    A recovered copy that omits the count reads as a review of every changed
    file, when one of them was never rendered.
    """
    destination = save_history(
        review(),
        [make_file("src/app.ts")],
        HistoryMeta(
            cwd=str(tmp_path),
            scope="working tree vs HEAD",
            mode="diff",
            dropped_paths=2,
            history_dir=str(tmp_path / "history"),
            now=AT,
        ),
    )
    assert destination, "expected the review to be archived"
    content = Path(destination).read_text(encoding="utf-8")
    assert re.search(r"^dropped-paths: 2$", content, re.MULTILINE)


def test_save_history_falls_back_to_the_env_var(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "env-history"
    monkeypatch.setenv("REVGATE_HISTORY_DIR", str(root))

    destination = save_history(review(), [], HistoryMeta(cwd=str(tmp_path), now=AT))
    assert destination == str(root / "no-repo" / "2026-07-29T15-30-00-123Z.md")


def test_no_history_writes_nothing(tmp_path: Path) -> None:
    root = tmp_path / "history"
    root.mkdir()
    destination = save_history(
        review(), [], HistoryMeta(cwd=str(root), history_dir=str(root), enabled=False, now=AT)
    )
    assert destination is None
    assert tree(root) == []


def test_an_approval_with_no_comments_is_not_worth_keeping(tmp_path: Path) -> None:
    root = tmp_path / "history"
    root.mkdir()
    destination = save_history(
        ReviewSubmission(decision="approve", summary="", comments=[]),
        [make_file("src/app.ts")],
        HistoryMeta(cwd=str(root), history_dir=str(root), now=AT),
    )
    assert destination is None
    assert tree(root) == []


def test_an_approval_with_comments_is_kept(tmp_path: Path) -> None:
    root = tmp_path / "history"
    destination = save_history(
        review(decision="approve"),
        [],
        HistoryMeta(cwd=str(tmp_path), history_dir=str(root), now=AT),
    )
    assert destination
    content = Path(destination).read_text(encoding="utf-8")
    assert re.search(r"^# revgate review: APPROVED$", content, re.MULTILINE)


def test_a_request_changes_with_no_comments_is_kept(tmp_path: Path) -> None:
    root = tmp_path / "history"
    destination = save_history(
        review(comments=[], summary=""),
        [],
        HistoryMeta(cwd=str(tmp_path), history_dir=str(root), now=AT),
    )
    assert destination


def test_two_reviews_in_the_same_millisecond_do_not_overwrite(tmp_path: Path) -> None:
    root = tmp_path / "history"

    def meta() -> HistoryMeta:
        return HistoryMeta(cwd=str(tmp_path), history_dir=str(root), now=AT)

    first = save_history(review(), [], meta())
    second = save_history(review(summary="second"), [], meta())

    assert first != second
    assert second == str(root / "no-repo" / "2026-07-29T15-30-00-123Z-1.md")
    assert second is not None
    assert "second" in Path(second).read_text(encoding="utf-8")
    assert len(tree(root)) == 2


def test_an_unwritable_directory_warns_instead_of_raising(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    blocker = tmp_path / "not-a-dir"
    # A plain file where the history root should be: mkdir cannot succeed.
    blocker.write_text("in the way\n", encoding="utf-8")

    result = save_history(
        review(), [], HistoryMeta(cwd=str(blocker), history_dir=str(blocker), now=AT)
    )
    assert result is None
    assert re.search(r"WARN could not save review history", capsys.readouterr().err)


def test_a_malformed_submission_is_skipped_never_raised_to_the_caller(
    make_repo: RepoFactory, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """`save_history`'s contract is "never raises".

    A raise here reaches the hook's fail-open handler, which reports the review
    as an *approval*.
    """
    repo = make_repo({"a.txt": "one\n"})
    root = tmp_path / "history"

    # Not constructible as a real ReviewSubmission — which is the point: only a
    # value that never went through `normalize_submission` can look like this.
    broken = cast("ReviewSubmission", SimpleNamespace(decision="request_changes"))
    result = save_history(
        broken, [make_file("src/app.ts")], HistoryMeta(cwd=repo.path, history_dir=str(root), now=AT)
    )
    assert result is None
    # None alone would also be the answer for `enabled=False` or "no findings",
    # so pin the assertion to the catch: the raise was swallowed, not sidestepped.
    assert re.search(r"WARN could not save review history", capsys.readouterr().err)


def test_the_history_document_is_written_with_lf_line_endings(tmp_path: Path) -> None:
    """The archive is a byte contract too: Windows must not turn every line into CRLF."""
    root = tmp_path / "history"
    destination = save_history(
        review(),
        [make_file("src/app.ts")],
        HistoryMeta(cwd=str(tmp_path), history_dir=str(root), now=AT),
    )
    assert destination
    assert b"\r\n" not in Path(destination).read_bytes()


def test_a_non_ascii_repo_name_is_sanitized_from_the_decoded_name(tmp_path: Path) -> None:
    """Via `find_repo_root`, so `core.quotePath=false` applies.

    `sanitize_segment` reduces any non-ASCII run to a single `-`, so the segment
    here is `caf--repo`. What matters is that it is derived from the *decoded*
    name: a C-quoted `caf\\303\\251-repo` would sanitize to `caf-303-251-repo`,
    archiving the repository under a directory nobody would recognise.
    """
    repo = init_repo(tmp_path / "café-repo", {"a.txt": "one\n"})
    assert repo_segment(str(repo.dir)) == "caf--repo"
    assert "303" not in repo_segment(str(repo.dir)), "the C-quoted form reached the segment"
