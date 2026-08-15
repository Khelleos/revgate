"""The git executor, against real temporary repositories."""

import shutil

import pytest

from revgate.git.exec import (
    HARDENED_CONFIG,
    MAX_OUTPUT_BYTES,
    GitError,
    find_repo_root,
    git,
    git_diff,
    git_error_message,
    has_head,
    is_git_repo,
    repo_root,
)
from tests.helpers.repo import RepoFactory


def test_hardened_config_pairs_every_key_with_a_dash_c() -> None:
    assert HARDENED_CONFIG[0] == "-c"
    assert len(HARDENED_CONFIG) % 2 == 0
    assert HARDENED_CONFIG[::2] == ["-c"] * (len(HARDENED_CONFIG) // 2)
    assert "core.quotePath=false" in HARDENED_CONFIG
    assert "diff.relative=false" in HARDENED_CONFIG
    assert "status.showUntrackedFiles=normal" in HARDENED_CONFIG


def test_git_returns_stdout(make_repo: RepoFactory) -> None:
    repo = make_repo({"a.txt": "one\n"})
    assert git(repo.path, ["rev-parse", "--is-inside-work-tree"]).strip() == "true"


def test_git_raises_on_a_non_zero_exit_and_keeps_stderr(make_repo: RepoFactory) -> None:
    repo = make_repo({"a.txt": "one\n"})
    with pytest.raises(GitError) as excinfo:
        git(repo.path, ["rev-parse", "--verify", "nope"])
    assert "fatal" in excinfo.value.stderr.lower()


def test_git_does_not_translate_crlf(make_repo: RepoFactory) -> None:
    """The diff parser needs CR exactly where git wrote it."""
    repo = make_repo({"a.txt": "one\n"})
    repo.write("crlf.txt", "first\r\nsecond\r\n")
    repo.commit("crlf")
    out = git(repo.path, ["show", "HEAD:crlf.txt"])
    assert out == "first\r\nsecond\r\n"


def test_git_diff_forces_the_external_differ_off(make_repo: RepoFactory) -> None:
    """`diff.external` is the one setting `-c` cannot disable, so the flag must be there."""
    repo = make_repo({"a.txt": "one\n"})
    # A "differ" that would replace the diff with a marker if it ever ran.
    repo.git("config", "diff.external", "false")
    repo.write("a.txt", "two\n")
    out = git_diff(repo.path, [])
    assert "-one" in out
    assert "+two" in out


def test_git_diff_produces_no_colour_codes(make_repo: RepoFactory) -> None:
    repo = make_repo({"a.txt": "one\n"})
    repo.git("config", "color.diff", "always")
    repo.write("a.txt", "two\n")
    assert "\x1b[" not in git_diff(repo.path, [])


def test_git_reads_output_larger_than_one_chunk(make_repo: RepoFactory) -> None:
    """The chunked read must reassemble, not truncate at the first chunk boundary."""
    repo = make_repo({"a.txt": "one\n"})
    big = "".join(f"line {n}\n" for n in range(60_000))
    repo.write("big.txt", big)
    repo.commit("big")
    out = git(repo.path, ["show", "HEAD:big.txt"])
    assert len(out) > 64 * 1024
    assert out == big


def test_the_output_cap_is_the_same_64mb_node_used() -> None:
    assert MAX_OUTPUT_BYTES == 64 * 1024 * 1024


def test_git_does_not_inherit_stdin(make_repo: RepoFactory) -> None:
    """git is spawned with `stdin=DEVNULL`, never the parent's stdin.

    A credential or passphrase prompt on an inherited stdin hangs the blocking
    hook forever, with no terminal to answer it. With DEVNULL the read hits EOF.
    """
    repo = make_repo({"a.txt": "one\n"})
    out = git(repo.path, ["hash-object", "--stdin"]).strip()
    # The hash of the empty blob: git read EOF immediately rather than blocking.
    assert out == "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"


def test_has_head_and_is_git_repo_report_what_a_repo_really_is(
    make_repo: RepoFactory, tmp_path_factory: pytest.TempPathFactory
) -> None:
    empty = make_repo()
    assert is_git_repo(empty.path) is True
    assert has_head(empty.path) is False, "a repo with no commits has no HEAD"

    with_commit = make_repo({"a.txt": "one\n"})
    assert has_head(with_commit.path) is True

    # A directory that is not a work tree at all.
    plain = tmp_path_factory.mktemp("not-a-repo")
    assert is_git_repo(str(plain)) is False
    assert has_head(str(plain)) is False


def test_the_probes_return_false_for_a_missing_directory(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    """A vanished cwd makes the spawn itself fail; the probes still answer, never raise."""
    missing = tmp_path_factory.mktemp("gone") / "not-here"
    assert is_git_repo(str(missing)) is False
    assert has_head(str(missing)) is False
    assert find_repo_root(str(missing)) is None


def test_find_repo_root_and_repo_root_resolve_the_toplevel_from_a_subdirectory(
    make_repo: RepoFactory,
) -> None:
    repo = make_repo({"sub/a.txt": "one\n"})
    sub = repo.dir / "sub"

    root = find_repo_root(str(sub))
    assert root is not None, "the toplevel did not resolve from a subdirectory"
    # The temp dir may be a symlinked path, so compare the final component.
    assert root.rstrip("/\\").split("/")[-1].split("\\")[-1] == repo.dir.name
    assert repo_root(str(sub)) == root


def test_outside_a_work_tree_the_two_root_forms_disagree_on_purpose(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    """`find_repo_root` says "not a repo"; `repo_root` falls back to somewhere it can run."""
    plain = str(tmp_path_factory.mktemp("plain"))
    assert find_repo_root(plain) is None
    assert repo_root(plain) == plain


def test_git_error_message_prefers_gits_own_fatal_line() -> None:
    err = GitError("git exited with code 128", "\nfatal: bad revision 'nope'\n")
    assert git_error_message(err, "could not diff") == "could not diff: fatal: bad revision 'nope'"


def test_git_error_message_falls_back_to_the_callers_wording() -> None:
    assert git_error_message(Exception("boom"), "could not diff") == "could not diff"
    assert git_error_message(None, "could not diff") == "could not diff"
    assert git_error_message(GitError("x", "   \n\n"), "could not diff") == "could not diff"


def test_git_error_message_skips_leading_blank_lines() -> None:
    err = GitError("x", "\n\n   \nwarning: something\nfatal: the real one\n")
    assert git_error_message(err, "nope") == "nope: warning: something"


@pytest.mark.skipif(shutil.which("git") is None, reason="git is required for the suite")
def test_the_hardened_config_actually_reaches_git(make_repo: RepoFactory) -> None:
    """`core.quotePath=false` is what keeps a non-ASCII path readable in the diff."""
    repo = make_repo({"a.txt": "one\n"})
    repo.write("héllo.txt", "x\n")
    out = git(repo.path, ["status", "--porcelain"])
    assert "héllo.txt" in out, "quotePath was not forced off"


def test_hardened_config_survives_a_hostile_repo_config(make_repo: RepoFactory) -> None:
    """A repo-local config must not be able to rewrite what the reviewer sees."""
    repo = make_repo({"sub/a.txt": "one\n"})
    repo.git("config", "diff.relative", "true")
    repo.git("config", "diff.noprefix", "true")
    repo.write("sub/a.txt", "two\n")
    # `diff.relative` would drop the `sub/` prefix when run from `sub/`;
    # `diff.noprefix` would drop `a/` and `b/`.
    out = git_diff(str(repo.dir / "sub"), [])
    assert "a/sub/a.txt" in out
    assert "b/sub/a.txt" in out


def test_git_error_carries_the_message_it_was_given() -> None:
    err = GitError("boom", "stderr text")
    assert str(err) == "boom"
    assert err.stderr == "stderr text"
