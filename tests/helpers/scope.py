"""Scope helpers shared by the git and review suites."""

import contextlib
import os
from collections.abc import Iterator
from pathlib import Path

from revgate.git.collect import collect_diff
from revgate.git.scope import DiffScope, ScopeKind, filter_files
from revgate.review.diff import parse_unified_diff
from tests.helpers.repo import TempRepo

HOSTILE_GIT_CONFIG = (
    # srcPrefix/dstPrefix are what `+++ b/<path>` cannot rescue; `external` is
    # difftastic, the one `-c` cannot switch off.
    "[diff]\n\trelative = true\n\tmnemonicPrefix = true\n\tnoprefix = true\n"
    "\tsrcPrefix = X/\n\tdstPrefix = Y/\n\texternal = echo EXTERNAL\n"
    "[status]\n\tshowUntrackedFiles = no\n"
)


def scope(kind: ScopeKind, **overrides: object) -> DiffScope:
    """Build a scope with the boilerplate empty filter arrays filled in."""
    return DiffScope(kind=kind, **overrides)  # type: ignore[arg-type]


def paths_for(directory: str, diff_scope: DiffScope) -> list[str]:
    """The paths a scope reports, sorted so assertions don't depend on git's order."""
    repo = collect_diff(directory, diff_scope)
    return sorted(f.path for f in filter_files(parse_unified_diff(repo.unified), diff_scope))


def add_untracked(repo: TempRepo) -> None:
    """Make a file that isn't in any commit, to prove ref scopes ignore it."""
    repo.write("untracked.txt", "loose\n")


@contextlib.contextmanager
def hostile_git_config(repo: TempRepo) -> Iterator[Path]:
    """Run the block with a hostile `~/.gitconfig` in force for every git process spawned.

    Each setting is a legitimate preference that corrupts a review; see agents.md.
    The file goes inside `.git/`: in the work tree it would join the diff under
    test as an untracked file.
    """
    config = repo.dir / ".git" / "hostile-gitconfig"
    config.write_text(HOSTILE_GIT_CONFIG, encoding="utf-8", newline="")
    saved = os.environ.get("GIT_CONFIG_GLOBAL")
    os.environ["GIT_CONFIG_GLOBAL"] = str(config)
    try:
        yield config
    finally:
        if saved is None:
            os.environ.pop("GIT_CONFIG_GLOBAL", None)
        else:
            os.environ["GIT_CONFIG_GLOBAL"] = saved
