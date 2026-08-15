"""A throwaway git repo on disk; nothing here touches the user's own repo or config."""

import os
import subprocess
import sys
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

import pytest

_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0


@dataclass(slots=True)
class TempRepo:
    """A temporary repository and the handful of operations the tests need."""

    dir: Path
    env: dict[str, str] = field(default_factory=dict)

    def git(self, *args: str) -> str:
        """Run a git command inside the repo and return stdout."""
        result = subprocess.run(
            ["git", *args],  # noqa: S607 — resolved on PATH, as everywhere else
            cwd=self.dir,
            env=self.env,
            capture_output=True,
            check=True,
            creationflags=_CREATE_NO_WINDOW,
        )
        return result.stdout.decode("utf-8", errors="replace")

    def write(self, rel_path: str, content: str) -> Path:
        """Write a file (creating parent directories) relative to the repo root."""
        target = self.dir / rel_path
        target.parent.mkdir(parents=True, exist_ok=True)
        # `newline=""` keeps the bytes exactly as given: a test that writes CRLF
        # means CRLF, and the diff parser is sensitive to it.
        target.write_text(content, encoding="utf-8", newline="")
        return target

    def commit(self, message: str) -> str:
        """Stage everything and commit. Returns the new commit SHA."""
        self.git("add", "-A")
        self.git("commit", "-m", message)
        return self.git("rev-parse", "HEAD").strip()

    @property
    def path(self) -> str:
        """The working tree as a string, which is what the source modules take."""
        return str(self.dir)


def init_repo(directory: Path, files: Mapping[str, str] | None = None) -> TempRepo:
    """Initialize a repository in `directory`, isolated from the contributor's git config.

    `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` name files that are never
    created, and git reads a missing config as empty. Without this a contributor
    who has `diff.relative` set watches these suites fail on their machine while
    a clean checkout passes.
    """
    directory.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env["GIT_CONFIG_GLOBAL"] = str(directory / ".no-global-gitconfig")
    env["GIT_CONFIG_SYSTEM"] = str(directory / ".no-system-gitconfig")
    env["GIT_CONFIG_NOSYSTEM"] = "1"

    repo = TempRepo(dir=directory, env=env)
    # A committable identity, and no signing prompt on `commit`.
    repo.git("init", "--initial-branch=main")
    repo.git("config", "user.email", "test@revgate.local")
    repo.git("config", "user.name", "revgate test")
    repo.git("config", "commit.gpgsign", "false")
    repo.git("config", "core.autocrlf", "false")
    # A global `core.hooksPath` would otherwise run the contributor's own hooks
    # against these repos; point it at a directory that is never created.
    repo.git("config", "core.hooksPath", str(directory / ".no-hooks"))

    if files:
        for rel, content in files.items():
            repo.write(rel, content)
        repo.commit("initial")
    return repo


class RepoFactory(Protocol):
    """Callable returned by the `make_repo` fixture."""

    def __call__(self, files: Mapping[str, str] | None = None) -> TempRepo: ...


@pytest.fixture
def make_repo(tmp_path_factory: pytest.TempPathFactory) -> RepoFactory:
    """Factory fixture: `make_repo({"a.txt": "one\\n"})` gives a repo with one commit."""
    counter = 0

    def factory(files: Mapping[str, str] | None = None) -> TempRepo:
        nonlocal counter
        counter += 1
        return init_repo(tmp_path_factory.mktemp(f"repo{counter}"), files)

    return factory
