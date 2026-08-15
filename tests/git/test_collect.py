"""Collecting a scope's diff, and the git config that must never be able to shrink it."""

import pytest

import revgate.git.collect as collect_module
from revgate.git.collect import collect_diff
from revgate.git.exec import GitError
from revgate.git.scope import ScopeError
from revgate.git.staging import get_stage_states, set_staged
from revgate.review.diff import parse_unified_diff
from tests.helpers.repo import RepoFactory, TempRepo
from tests.helpers.scope import add_untracked, hostile_git_config, paths_for, scope


def parsed_paths(unified: str) -> list[str]:
    return sorted(f.path for f in parse_unified_diff(unified))


def diverged_repo(make_repo: RepoFactory) -> TempRepo:
    """main and feature diverge after a shared base, so `..` and `...` differ."""
    repo = make_repo({"src/a.ts": "a1\n"})
    repo.git("checkout", "-b", "feature")
    repo.write("src/feature.ts", "f1\n")
    repo.commit("feature work")
    repo.git("checkout", "main")
    repo.write("src/main.ts", "m1\n")
    repo.commit("main work")
    return repo


def test_reports_a_non_repo_and_still_labels_the_scope(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    plain = str(tmp_path_factory.mktemp("plain"))

    result = collect_diff(plain, scope("ref", refs=["main"]))
    assert result.is_repo is False
    assert result.unified == ""
    assert result.branch is None
    assert result.scope_label == "main vs working tree"


def test_worktree_scope_covers_staged_unstaged_and_untracked(make_repo: RepoFactory) -> None:
    repo = make_repo({"src/a.ts": "a1\n", "docs/b.md": "b1\n"})

    repo.write("src/a.ts", "a2\n")
    repo.git("add", "src/a.ts")  # staged
    repo.write("docs/b.md", "b2\n")  # unstaged
    add_untracked(repo)

    result = collect_diff(repo.path, scope("worktree"))
    assert result.is_repo is True
    assert result.branch == "main"
    assert result.scope_label == "working tree vs HEAD"
    assert result.untracked == ["untracked.txt"]
    assert parsed_paths(result.unified) == ["docs/b.md", "src/a.ts", "untracked.txt"]


def test_staged_scope_sees_only_the_index_never_untracked_files(
    make_repo: RepoFactory,
) -> None:
    repo = make_repo({"src/a.ts": "a1\n", "docs/b.md": "b1\n"})

    repo.write("src/a.ts", "a2\n")
    repo.git("add", "src/a.ts")
    repo.write("docs/b.md", "b2\n")  # left unstaged
    add_untracked(repo)

    result = collect_diff(repo.path, scope("staged"))
    assert result.scope_label == "staged changes"
    assert result.untracked == []
    assert parsed_paths(result.unified) == ["src/a.ts"]


def test_a_single_ref_compares_that_ref_against_the_working_tree(
    make_repo: RepoFactory,
) -> None:
    repo = make_repo({"src/a.ts": "a1\n"})

    repo.write("src/b.ts", "b1\n")
    repo.commit("second")
    repo.write("src/a.ts", "a2\n")  # uncommitted, still in the working tree

    result = collect_diff(repo.path, scope("ref", refs=["HEAD~1"]))
    assert result.scope_label == "HEAD~1 vs working tree"
    assert parsed_paths(result.unified) == ["src/a.ts", "src/b.ts"]


def test_a_ref_scope_never_synthesizes_untracked_files(make_repo: RepoFactory) -> None:
    repo = make_repo({"src/a.ts": "a1\n"})

    repo.write("src/b.ts", "b1\n")
    repo.commit("second")
    add_untracked(repo)

    result = collect_diff(repo.path, scope("ref", refs=["HEAD~1"]))
    assert result.untracked == []
    assert parsed_paths(result.unified) == ["src/b.ts"]

    # …but the same file DOES show up when the scope is the working tree.
    worktree = collect_diff(repo.path, scope("worktree"))
    assert "untracked.txt" in parsed_paths(worktree.unified)


def test_two_refs_diff_the_endpoints_against_each_other(make_repo: RepoFactory) -> None:
    repo = diverged_repo(make_repo)
    add_untracked(repo)

    result = collect_diff(repo.path, scope("range", refs=["main", "feature"], dots=".."))
    assert result.scope_label == "main..feature"
    assert result.untracked == []
    # feature relative to main: it has src/feature.ts and lacks src/main.ts.
    files = parse_unified_diff(result.unified)
    assert sorted(f.path for f in files) == ["src/feature.ts", "src/main.ts"]
    by_path = {f.path: f for f in files}
    assert by_path["src/feature.ts"].is_new is True
    assert by_path["src/main.ts"].is_deleted is True


def test_a_three_dot_range_diffs_from_the_merge_base(make_repo: RepoFactory) -> None:
    repo = diverged_repo(make_repo)

    result = collect_diff(repo.path, scope("range", refs=["main", "feature"], dots="..."))
    assert result.scope_label == "main...feature"
    # From the merge base, only feature's own commit shows — main's is not "removed".
    assert parsed_paths(result.unified) == ["src/feature.ts"]


def test_a_range_with_no_merge_base_is_a_scope_error_not_a_crash(
    make_repo: RepoFactory,
) -> None:
    """Both refs resolve, so verify_ref passes; it is the *combination* git rejects.

    That is bad usage (exit 2), not the unexpected-error path (exit 1).
    """
    repo = make_repo({"a.txt": "one\n"})
    first = repo.git("rev-parse", "HEAD").strip()

    # An orphan branch shares no history with main.
    repo.git("checkout", "--orphan", "other")
    repo.git("rm", "-rf", "--cached", ".")
    repo.write("b.txt", "two\n")
    repo.commit("orphan")
    orphan = repo.git("rev-parse", "HEAD").strip()

    with pytest.raises(ScopeError, match="could not diff"):
        collect_diff(repo.path, scope("range", refs=[first, orphan], dots="..."))


def test_a_repository_with_no_commits_still_reports_its_staged_files(
    make_repo: RepoFactory,
) -> None:
    """`git init` + `git add .` + a first agent turn is the very first run a new user hits.

    HEAD does not resolve yet.
    """
    repo = make_repo()
    repo.write("first.txt", "hello\n")
    repo.git("add", "-A")

    out = collect_diff(repo.path, scope("worktree"))
    assert out.is_repo is True
    assert parsed_paths(out.unified) == ["first.txt"]


def test_untracked_files_are_repo_root_relative_from_a_subdirectory(
    make_repo: RepoFactory,
) -> None:
    """`git ls-files --others` prints cwd-relative paths and only walks the cwd subtree.

    `git diff` is root-relative from anywhere. Reviewing from a subdirectory
    used to drop untracked files outside it and put the rest in a different
    namespace from the tracked diff, breaking filter_files and the stage lookup.
    """
    repo = make_repo({"sub/tracked.txt": "one\n"})
    repo.write("sub/tracked.txt", "one\ntwo\n")
    repo.write("sub/nested.txt", "nested\n")
    repo.write("root.txt", "root\n")

    result = collect_diff(str(repo.dir / "sub"), scope("worktree"))
    assert sorted(result.untracked) == ["root.txt", "sub/nested.txt"]
    assert parsed_paths(result.unified) == ["root.txt", "sub/nested.txt", "sub/tracked.txt"]


def test_a_path_staged_for_deletion_but_still_on_disk_is_reported_once(
    make_repo: RepoFactory,
) -> None:
    """`git rm --cached` is the one command that puts a path in BOTH lists.

    The index has the deletion (so `diff HEAD` reports it) while the file is
    still on disk and now untracked (so `ls-files --others` reports it too). Two
    DiffFiles with the same path double-count the file, render two
    indistinguishable sidebar rows, list every remark on it twice, and make the
    new-side comment lookup resolve against the deleted entry — so it quotes
    back no code at all.
    """
    repo = make_repo({"x.txt": "one\ntwo\n"})
    repo.git("rm", "--cached", "x.txt")

    diff = collect_diff(repo.path, scope("worktree"))
    files = [f for f in parse_unified_diff(diff.unified) if f.path == "x.txt"]
    assert len(files) == 1, "one entry per path"
    assert files[0].is_deleted is True, "the tracked view against HEAD wins"
    # The reported untracked list has to agree with the diff it produced.
    assert diff.untracked == []

    # …and the staged deletion is not buried by the `??` record git prints after
    # it: reporting "no" here makes the UI offer a stage toggle whose `git add`
    # silently reverts the deletion.
    assert get_stage_states(repo.path)["x.txt"] == "yes"


def test_an_ordinary_untracked_file_is_still_synthesized(make_repo: RepoFactory) -> None:
    """The dedupe must key on the path being in the tracked diff.

    Not on "there is a tracked diff at all" — untracked files are the reason the
    worktree scope synthesizes anything.
    """
    repo = make_repo({"a.txt": "one\n"})
    repo.write("a.txt", "one\ntwo\n")
    repo.write("new.txt", "fresh\n")

    assert paths_for(repo.path, scope("worktree")) == ["a.txt", "new.txt"]


# --- inherited git config ---------------------------------------------------


def test_the_reviewers_own_diff_config_cannot_shrink_or_rename_the_review(
    make_repo: RepoFactory,
) -> None:
    """A binary file has no `---`/`+++` lines, so its path comes only from the header.

    It is the only case that actually depends on the prefix pins: a text file
    whose header prefix is mangled is still rescued by `+++`, which is why this
    suite used to pass with noprefix/srcPrefix/dstPrefix removed from
    HARDENED_CONFIG.
    """
    repo = make_repo({"root.txt": "a\n", "src/deep/a.ts": "b\n"})
    (repo.dir / "src" / "deep" / "logo.png").write_bytes(bytes([0x89, 0x50, 0x00, 1]))
    repo.commit("add a binary file")

    repo.write("root.txt", "a2\n")
    repo.write("src/deep/a.ts", "b2\n")
    (repo.dir / "src" / "deep" / "logo.png").write_bytes(bytes([0x89, 0x50, 0x00, 2, 3]))

    with hostile_git_config(repo):
        # From a SUBDIRECTORY, which is how an agent invokes the CLI, and the
        # case diff.relative silently truncates: root.txt sits outside src/deep.
        sub = str(repo.dir / "src" / "deep")
        assert paths_for(sub, scope("worktree")) == [
            "root.txt",
            "src/deep/a.ts",
            "src/deep/logo.png",
        ]
        # Root-relative paths mean the -I prefix filter still resolves.
        assert paths_for(sub, scope("worktree", include=["src"])) == [
            "src/deep/a.ts",
            "src/deep/logo.png",
        ]


def test_an_external_diff_driver_cannot_empty_the_review(make_repo: RepoFactory) -> None:
    """`diff.external` replaces git's unified output with the driver's, and git exits 0.

    Without `--no-ext-diff` the parser returns [], the review takes the "nothing
    to review" branch, and the gate reports APPROVED at exit 0 over a diff
    nobody saw. It is the one setting `-c` cannot switch off (`-c diff.external=`
    makes git try to spawn the empty string and die), so only the flag works.
    """
    repo = make_repo({"a.txt": "one\n"})
    repo.write("a.txt", "one\ntwo\n")

    with hostile_git_config(repo):
        result = collect_diff(repo.path, scope("worktree"))
        assert "EXTERNAL" not in result.unified, "the external driver's output reached the review"
        files = parse_unified_diff(result.unified)
        assert [f.path for f in files] == ["a.txt"]
        assert files[0].additions == 1, "the hunk body was lost"


def test_the_same_external_driver_through_the_environment_cannot_empty_the_review(
    make_repo: RepoFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    """How a shell wrapper or an editor integration exports it."""
    repo = make_repo({"a.txt": "one\n"})
    repo.write("a.txt", "one\ntwo\n")

    monkeypatch.setenv("GIT_EXTERNAL_DIFF", "echo EXTERNAL")
    result = collect_diff(repo.path, scope("worktree"))
    assert [f.path for f in parse_unified_diff(result.unified)] == ["a.txt"]


def test_a_non_ascii_path_survives_as_the_real_name_on_disk(make_repo: RepoFactory) -> None:
    """git C-quotes any path with a non-ASCII byte unless core.quotePath=false.

    The quoted form (`"caf\\303\\251.txt"`) resolves to nothing: filter_files
    would drop the file from every -I/-X review, the stage lookup would never
    match the raw `status -z` name, and the annotation would point at no file.
    """
    repo = make_repo({"café.txt": "one\n"})
    repo.write("café.txt", "one\ntwo\n")
    repo.write("src/日本.md", "new\n")

    assert paths_for(repo.path, scope("worktree")) == ["café.txt", "src/日本.md"]

    # The two consumers that would silently mislead if the name were mangled.
    # Prefixes match at path boundaries, so the filter is the whole file name
    # here (`café` alone is a mid-name prefix and matches nothing).
    assert paths_for(repo.path, scope("worktree", include=["café.txt"])) == ["café.txt"]
    assert paths_for(repo.path, scope("worktree", include=["src"])) == ["src/日本.md"]
    assert get_stage_states(repo.path)["café.txt"] == "no"
    assert set_staged(repo.path, "café.txt", True)["café.txt"] == "yes"


def test_the_untracked_scan_failure_is_carried_not_swallowed(
    make_repo: RepoFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Swallowed, a failed scan drops every untracked file at once.

    Downstream that reads as "nothing to review, approve", so the flag has to
    survive into the result and the tracked half has to stay intact.
    """
    repo = make_repo({"a.txt": "one\n"})
    repo.write("a.txt", "one\ntwo\n")
    repo.write("new.txt", "fresh\n")

    real_git = collect_module.git  # type: ignore[attr-defined]

    def fail_ls_files(cwd: str, args: list[str]) -> str:
        if "ls-files" in args:
            raise GitError("git exited with code 128", "fatal: ls-files is unavailable")
        return real_git(cwd, args)

    monkeypatch.setattr(collect_module, "git", fail_ls_files)
    diff = collect_diff(repo.path, scope("worktree"))

    assert diff.untracked_scan_failed is True
    assert diff.untracked == []
    # The tracked half of the review is still there, and is not mistaken for
    # a clean tree.
    assert parsed_paths(diff.unified) == ["a.txt"]
