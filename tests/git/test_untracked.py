"""Untracked files: what gets synthesized, what gets elided, and what must never be dropped."""

import os
import sys
from pathlib import Path

import pytest

from revgate.git.collect import collect_diff
from revgate.git.untracked import looks_binary
from revgate.review.diff import parse_unified_diff
from revgate.shared.types import DiffFile
from tests.helpers.repo import RepoFactory
from tests.helpers.scope import scope


def symlink_or_skip(target: Path, link_path: Path) -> None:
    """Create a symlink, or skip where the platform will not allow one.

    Windows needs Developer Mode or an elevated shell for a file symlink, and a
    contributor without either should not see a red suite.
    """
    try:
        link_path.symlink_to(target)
    except (OSError, NotImplementedError) as err:
        pytest.skip(f"symlinks unavailable on this platform: {err}")


def find(files: list[DiffFile], path: str) -> DiffFile | None:
    return next((f for f in files if f.path == path), None)


def added_lines(diff_file: DiffFile) -> list[str]:
    return [line.content for hunk in diff_file.hunks for line in hunk.lines if line.type == "add"]


def worktree_diff(repo_path: str) -> str:
    return collect_diff(repo_path, scope("worktree")).unified


def test_looks_binary_marks_a_nul_byte_in_the_first_8kb() -> None:
    assert looks_binary(b"plain text\n") is False
    assert looks_binary(bytes([0x89, 0x50, 0x00, 0x01])) is True
    assert looks_binary(b"") is False
    # Past the 8KB window the heuristic deliberately stops looking, the way git does.
    assert looks_binary(b"a" * 9000 + b"\x00") is False


def test_an_untracked_binary_file_is_reported_as_binary(make_repo: RepoFactory) -> None:
    repo = make_repo({"a.txt": "one\n"})
    (repo.dir / "logo.png").write_bytes(bytes([0x89, 0x50, 0x00, 0x01, 0x02]))

    png = find(parse_unified_diff(worktree_diff(repo.path)), "logo.png")
    assert png is not None, "the untracked binary never made it into the diff"
    # The UI shows a placeholder for these; misreporting one renders NUL bytes.
    assert png.is_binary is True


def test_an_oversized_untracked_file_is_listed_but_not_inlined(make_repo: RepoFactory) -> None:
    """The tracked diff is bounded by git's own cap; an untracked file is read by us.

    Without a cap one stray log or dump is read whole, split into per-line
    objects, and JSON-serialized to the browser — a memory spike and a UI nobody
    can scroll. It still has to appear, or a file silently leaves the review.
    """
    repo = make_repo({"a.txt": "one\n"})
    (repo.dir / "huge.log").write_text("x" * (3 * 1024 * 1024) + "\n", encoding="utf-8")

    huge = find(parse_unified_diff(worktree_diff(repo.path)), "huge.log")
    assert huge is not None, "the oversized file vanished from the review"
    assert huge.is_binary is True, "shown as unexpanded, the way a binary file is"
    assert huge.hunks == [], "3MB of content must not be inlined"


def test_untracked_expansion_stops_at_a_total_byte_budget(make_repo: RepoFactory) -> None:
    """The per-file cap does not bound the *set*, and the worktree scope expands every path.

    An un-gitignored data or dist tree used to be read whole, concatenated,
    re-split per line, and JSON-serialized — an OOM or a hook that outlives its
    timeout. One long line per file keeps the parse cheap.
    """
    repo = make_repo({"a.txt": "one\n"})
    names = ["d1.log", "d2.log", "d3.log", "d4.log", "d5.log", "d6.log"]
    for name in names:
        repo.write(name, "x" * 1_900_000 + "\n")

    files = parse_unified_diff(worktree_diff(repo.path))
    assert sorted(f.path for f in files) == sorted(names), (
        "every untracked file must still be listed"
    )
    # 8MB of budget at ~1.9MB each: four expand, the remainder is listed unexpanded.
    assert [f.path for f in files if f.hunks] == ["d1.log", "d2.log", "d3.log", "d4.log"]
    for name in ("d5.log", "d6.log"):
        elided = find(files, name)
        assert elided is not None
        assert elided.is_binary is True, f"{name} should be listed the way an unexpanded file is"


def test_untracked_expansion_stops_at_a_file_count_budget(make_repo: RepoFactory) -> None:
    """A wide tree of small files never reaches the byte total.

    It still costs a read, a per-line object graph, and a JSON copy per file.
    """
    repo = make_repo({"a.txt": "one\n"})
    # Zero-padded so `git ls-files` order (lexicographic) is the order asserted.
    names = [f"many/f{index:04d}.txt" for index in range(305)]
    for name in names:
        repo.write(name, "content\n")

    files = parse_unified_diff(worktree_diff(repo.path))
    assert len(files) == len(names), "every untracked file must still be listed"
    expanded = [f.path for f in files if f.hunks]
    assert len(expanded) == 300
    assert expanded == names[:300]


def test_an_untracked_empty_file_appears_with_no_hunks(make_repo: RepoFactory) -> None:
    repo = make_repo({"a.txt": "one\n"})
    (repo.dir / "empty.txt").write_text("", encoding="utf-8")

    empty = find(parse_unified_diff(worktree_diff(repo.path)), "empty.txt")
    assert empty is not None, "the empty untracked file was dropped entirely"
    assert empty.hunks == []
    assert empty.is_binary is False


def test_an_untracked_file_with_no_trailing_newline_keeps_its_last_line(
    make_repo: RepoFactory,
) -> None:
    repo = make_repo({"a.txt": "one\n"})
    repo.write("tail.txt", "first\nsecond")

    tail = find(parse_unified_diff(worktree_diff(repo.path)), "tail.txt")
    assert tail is not None
    assert added_lines(tail) == ["first", "second"]


def test_an_untracked_file_with_a_non_ascii_name_is_still_reviewed(
    make_repo: RepoFactory,
) -> None:
    """`git ls-files` C-quotes non-ASCII paths unless asked for NUL-terminated output.

    A quoted path does not resolve on disk, so the file would leave the diff
    with only a stderr warning behind it.
    """
    repo = make_repo({"a.txt": "one\n"})
    repo.write("café.txt", "crème\n")

    result = collect_diff(repo.path, scope("worktree"))
    assert result.untracked == ["café.txt"]
    assert [f.path for f in parse_unified_diff(result.unified)] == ["café.txt"]


def test_an_untracked_symlink_is_recorded_as_a_link_not_its_targets_content(
    make_repo: RepoFactory,
) -> None:
    """git stores a symlink as mode 120000 whose whole content is the target path.

    Dereferencing shows content that is not in the repository at all — and
    writes it into the markdown archived under ~/.revgate/history. An untracked
    `config -> ~/.aws/credentials` used to get its secrets inlined into both.
    """
    repo = make_repo({"a.txt": "one\n"})
    outside = repo.dir / "outside-secret.txt"
    outside.write_text("AWS_SECRET_ACCESS_KEY=hunter2\n", encoding="utf-8")
    repo.write(".gitignore", "outside-secret.txt\n")
    repo.commit("ignore the secret")
    symlink_or_skip(outside, repo.dir / "creds.link")

    unified = worktree_diff(repo.path)

    assert "hunter2" not in unified, "the target's content leaked into the diff"
    assert "new file mode 120000" in unified, "a symlink must not be announced as 100644"
    link = find(parse_unified_diff(unified), "creds.link")
    assert link is not None, "the untracked symlink left the review entirely"
    # What git itself shows for a new symlink: one added line, the target path.
    assert added_lines(link) == [str(outside)]


def test_a_symlink_reporting_size_zero_cannot_bypass_the_untracked_budget(
    make_repo: RepoFactory,
) -> None:
    """`stat` follows links, so a link to a FIFO or /dev/zero reported size 0.

    It passed both the per-file cap and the shared budget, and the read then
    blocked with no writer or grew until OOM — the hook outliving its timeout
    instead of gating the agent. `lstat` sizes the link itself.
    """
    repo = make_repo({"a.txt": "one\n"})
    big = repo.dir / "big.bin"
    big.write_text("x" * (3 * 1024 * 1024) + "\n", encoding="utf-8")
    repo.write(".gitignore", "big.bin\n")
    repo.commit("ignore the payload")
    symlink_or_skip(big, repo.dir / "big.link")

    unified = worktree_diff(repo.path)

    # Oversized target, but the link expands to its own tiny content, not the 3MB.
    assert len(unified) < 64 * 1024, "the link's target was inlined"
    link = find(parse_unified_diff(unified), "big.link")
    assert link is not None, "the symlink left the review"
    assert added_lines(link) == [str(big)]


def test_a_symlink_elided_by_the_file_budget_is_still_announced_as_a_symlink(
    make_repo: RepoFactory,
) -> None:
    """The budget decides whether a path is *expanded*, never what it *is*.

    An early return on the budget before `lstat` headed every untracked symlink
    past the 300-file ceiling as `new file mode 100644` — the same lie about
    what the repository would gain on commit that the mode handling exists to
    prevent, just moved past a threshold nobody reads the code at.
    """
    repo = make_repo({"a.txt": "one\n"})
    target = repo.dir / "outside-secret.txt"
    target.write_text("AWS_SECRET_ACCESS_KEY=hunter2\n", encoding="utf-8")
    repo.write(".gitignore", "outside-secret.txt\n")
    repo.commit("ignore the secret")

    # `zz.link` sorts last, so the 300-file budget is spent before it is reached.
    for index in range(305):
        repo.write(f"many/f{index:04d}.txt", "content\n")
    symlink_or_skip(target, repo.dir / "zz.link")

    unified = worktree_diff(repo.path)
    assert "hunter2" not in unified, "the target's content leaked into the diff"

    link = find(parse_unified_diff(unified), "zz.link")
    assert link is not None, "the elided symlink left the review entirely"
    assert link.hunks == [], "the link should have been elided, not expanded"
    assert "diff --git a/zz.link b/zz.link\nnew file mode 120000\n" in unified, (
        "an elided symlink was announced as a regular file"
    )


def test_a_healthy_untracked_scan_does_not_flag_itself_as_failed(
    make_repo: RepoFactory,
) -> None:
    """The negative half of the `untracked_scan_failed` contract.

    The report turns the flag into SCAN FAILED and exit 2, so a false positive
    breaks every clean run.
    """
    repo = make_repo({"a.txt": "one\n"})
    repo.write("new.txt", "fresh\n")

    diff = collect_diff(repo.path, scope("worktree"))
    assert diff.untracked == ["new.txt"]
    assert not diff.untracked_scan_failed
    assert not diff.dropped_untracked


def test_an_untracked_file_whose_name_has_a_newline_is_counted_not_just_warned(
    make_repo: RepoFactory,
) -> None:
    """Dropping the path is right; dropping it *silently* is not.

    Everything downstream is line-oriented, and a newline would splice phantom
    `## path:line` records into the report. But a tree whose only change is such
    a file used to review as APPROVED with `files: 0`, and only stderr said
    otherwise — which is exactly what an agent reading `-o <file>` never sees.
    """
    repo = make_repo({"a.txt": "one\n"})
    try:
        (repo.dir / "ev\nil.txt").write_text("content\n", encoding="utf-8")
    except OSError as err:
        # Windows rejects a newline in a filename outright; there is nothing to test.
        pytest.skip(f"newlines in filenames unavailable on this platform: {err}")

    diff = collect_diff(repo.path, scope("worktree"))
    assert diff.untracked == [], "the unsafe path must not reach the synthesized diff"
    assert diff.dropped_untracked == 1, "the drop left no trace on the diff"


@pytest.mark.skipif(sys.platform == "win32", reason="chmod 0o000 does not forbid reads on Windows")
def test_an_unreadable_untracked_file_is_listed_unexpanded_never_dropped(
    make_repo: RepoFactory,
) -> None:
    """Returning "" for an unreadable file removed it from the output entirely.

    That is the one path where a file silently leaves the review, and nothing
    else guards the invariant.
    """
    if hasattr(os, "getuid") and os.getuid() == 0:
        pytest.skip("root reads files regardless of their mode")
    repo = make_repo({"a.txt": "one\n"})
    locked = repo.write("locked.txt", "cannot be read\n")
    locked.chmod(0o000)

    diff = collect_diff(repo.path, scope("worktree"))
    assert not diff.untracked_scan_failed, "one unreadable file is not a failed scan"
    assert "cannot be read" not in diff.unified, "unreadable content leaked into the diff"
    entry = find(parse_unified_diff(diff.unified), "locked.txt")
    assert entry is not None, "the unreadable file left the review entirely"
    assert entry.hunks == [], "there is no readable content to expand"
