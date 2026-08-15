"""Reading and toggling the index state of a reviewed path."""

import re
import subprocess

import pytest

from revgate.git.staging import get_stage_states, set_staged
from tests.helpers.repo import RepoFactory
from tests.helpers.scope import hostile_git_config


def test_get_stage_states_distinguishes_staged_partial_untracked_and_unstaged(
    make_repo: RepoFactory,
) -> None:
    repo = make_repo({"staged.txt": "one\n", "partial.txt": "one\n", "dirty.txt": "one\n"})

    repo.write("staged.txt", "two\n")
    repo.git("add", "--", "staged.txt")

    repo.write("partial.txt", "two\n")
    repo.git("add", "--", "partial.txt")
    repo.write("partial.txt", "three\n")  # staged, then diverged again

    repo.write("dirty.txt", "two\n")  # never staged
    repo.write("new.txt", "brand new\n")  # untracked

    states = get_stage_states(repo.path)
    assert states["staged.txt"] == "yes"
    assert states["partial.txt"] == "partial"
    assert states["dirty.txt"] == "no"
    assert states["new.txt"] == "no"


def test_a_path_named_like_a_dunder_is_a_key_like_any_other(make_repo: RepoFactory) -> None:
    """A path is data, never an attribute lookup."""
    repo = make_repo({"__proto__": "one\n", "__class__": "one\n"})

    repo.write("__proto__", "two\n")
    repo.git("add", "--", "__proto__")
    repo.write("__class__", "two\n")

    states = get_stage_states(repo.path)
    assert states["__proto__"] == "yes"
    assert states["__class__"] == "no"
    assert "keys" not in states, "an unchanged path must have no state"


def test_a_global_show_untracked_files_no_still_reports_untracked_files(
    make_repo: RepoFactory,
) -> None:
    repo = make_repo({"root.txt": "a\n"})
    repo.write("fresh.txt", "new\n")

    with hostile_git_config(repo):
        assert get_stage_states(repo.path)["fresh.txt"] == "no"


def test_a_conflicted_path_is_unmerged_not_partially_staged(make_repo: RepoFactory) -> None:
    """Both status columns are non-blank on a conflict, so `UU` used to classify as "partial".

    That is an indeterminate checkbox whose unstage direction runs
    `git reset -- <path>`, which drops index stages 1/2/3: status flips to ` M`
    while MERGE_HEAD and the conflict markers remain, so the conflict looks
    resolved and the next commit records the markers as the resolution.
    """
    repo = make_repo({"a.txt": "base\n", "clean.txt": "one\n"})

    repo.git("checkout", "-b", "other")
    repo.write("a.txt", "theirs\n")
    repo.commit("theirs")
    repo.git("checkout", "main")
    repo.write("a.txt", "ours\n")
    repo.commit("ours")
    with pytest.raises(subprocess.CalledProcessError):
        repo.git("merge", "other")

    repo.write("clean.txt", "two\n")
    repo.git("add", "--", "clean.txt")

    states = get_stage_states(repo.path)
    assert states["a.txt"] == "unmerged"
    # A real staged file alongside the conflict is unaffected.
    assert states["clean.txt"] == "yes"


def test_an_add_add_conflict_is_unmerged_not_partially_staged(make_repo: RepoFactory) -> None:
    """git reports both-added as `AA` and both-deleted as `DD` — neither column is `U`.

    Without the extra clauses in `_is_unmerged` both columns are simply
    non-blank, so the path classifies as "partial" and the unstage direction
    drops the conflict stages.
    """
    repo = make_repo({"base.txt": "base\n"})

    repo.git("checkout", "-b", "other")
    repo.write("added.txt", "theirs\n")
    repo.commit("theirs add")
    repo.git("checkout", "main")
    repo.write("added.txt", "ours\n")
    repo.commit("ours add")
    with pytest.raises(subprocess.CalledProcessError):
        repo.git("merge", "other")

    assert re.search(r"^AA ", repo.git("status", "--porcelain=v1"), re.MULTILINE), (
        "not an add/add conflict"
    )
    assert get_stage_states(repo.path)["added.txt"] == "unmerged"


def test_an_unreadable_repository_degrades_to_no_states(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    """The review command calls this after collect_diff.

    A git failure here must not take down a review that already has its diff —
    every file just shows an unchecked Staged toggle.
    """
    gone = tmp_path_factory.mktemp("gone") / "not-here"
    assert get_stage_states(str(gone)) == {}


def test_a_staged_rename_does_not_shift_the_following_records(make_repo: RepoFactory) -> None:
    """Rename records carry the original path in an extra NUL field.

    Skipping it wrongly would key every later file's state to the wrong path.
    """
    repo = make_repo({"old.txt": "one\n", "zzz.txt": "one\n"})

    repo.git("mv", "old.txt", "new.txt")
    repo.write("zzz.txt", "two\n")

    states = get_stage_states(repo.path)
    assert states["new.txt"] == "yes", "the renamed file lost its state"
    assert states["zzz.txt"] == "no", "a later file inherited the rename's state"
    assert "old.txt" not in states


def test_a_working_tree_rename_does_not_synthesize_a_phantom_path(
    make_repo: RepoFactory,
) -> None:
    """git reports a working-tree rename as ` R new` — the R is in the Y column, not X.

    That record carries its origin path in the same extra NUL field. Testing
    only X left the origin token to be parsed as a record of its own, keying a
    state to `origin[3:]`: here `ab/zz.txt` becomes `zz.txt`, a real file whose
    genuine state the phantom then overwrote.
    """
    repo = make_repo({"ab/zz.txt": "one\n", "zz.txt": "one\n"})

    (repo.dir / "ab" / "zz.txt").rename(repo.dir / "zzz.txt")
    repo.git("add", "-N", "--", "zzz.txt")  # intent-to-add: git now sees a rename

    states = get_stage_states(repo.path)
    repo.write("zz.txt", "two\n")
    repo.git("add", "--", "zz.txt")
    after = get_stage_states(repo.path)

    assert "zz.txt" not in states, "an unchanged file must not gain a state"
    assert after["zz.txt"] == "yes", "the phantom overwrote a fully staged file's state"


def test_set_staged_stages_a_root_relative_path_from_a_subdirectory(
    make_repo: RepoFactory,
) -> None:
    repo = make_repo({"sub/a.txt": "one\n"})
    repo.write("sub/a.txt", "one\ntwo\n")

    states = set_staged(str(repo.dir / "sub"), "sub/a.txt", True)
    assert states["sub/a.txt"] == "yes"


def test_set_staged_unstages_and_reports_the_refreshed_states(make_repo: RepoFactory) -> None:
    repo = make_repo({"a.txt": "one\n"})
    repo.write("a.txt", "two\n")
    repo.git("add", "--", "a.txt")
    assert get_stage_states(repo.path)["a.txt"] == "yes"

    states = set_staged(repo.path, "a.txt", False)
    assert states["a.txt"] == "no"


def test_a_git_failure_raises_instead_of_reporting_the_unchanged_states(
    make_repo: RepoFactory,
) -> None:
    """Swallowing it made /api/stage answer 200 with the states it failed to change.

    The page then could not tell "git refused" from "already in that state" —
    the checkbox just snapped back with nothing to explain why.
    """
    repo = make_repo({"a.txt": "one\n"})

    with pytest.raises(RuntimeError) as excinfo:
        set_staged(repo.path, "no-such-file.txt", True)
    message = str(excinfo.value)
    assert "could not stage no-such-file.txt" in message
    # The reason git gave, not a generic "the command failed" wrapper.
    assert re.search(r"pathspec|did not match", message, re.IGNORECASE)
