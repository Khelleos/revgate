"""Architecture rules that the whole git layer depends on.

`HARDENED_CONFIG` and `--no-ext-diff` live on `git()` and `git_diff()`. A call
site that reaches `subprocess` directly inherits the reviewer's own gitconfig,
which renames or silently drops files from the review — and the reviewer has no
way to see that it happened. These two tests are the only thing keeping that
rule true as the project grows.
"""

import ast
from pathlib import Path

import revgate

SRC = Path(revgate.__file__).parent

#: `git/exec.py` is the executor itself; `server/browser.py` opens the review page.
MAY_SPAWN = {"git/exec.py", "server/browser.py"}

#: The raw runners carry no caller-side hardening, so they stay inside the package.
RAW_RUNNERS = {"git", "git_diff"}

EXEC_MODULE = "revgate.git.exec"


def python_modules() -> list[tuple[str, ast.Module]]:
    """Every module in the installed package, as `[posixRelativePath, parsedTree]`."""
    found = []
    for path in sorted(SRC.rglob("*.py")):
        rel = path.relative_to(SRC).as_posix()
        found.append((rel, ast.parse(path.read_text(encoding="utf-8"), filename=str(path))))
    assert found, f"no modules were found under {SRC}"
    return found


def test_only_the_executor_and_the_browser_opener_may_spawn_a_process() -> None:
    for rel, tree in python_modules():
        if rel in MAY_SPAWN:
            continue
        for node in ast.walk(tree):
            # The import is the rule, not just the call: a module that cannot
            # name `subprocess` cannot reach it through an alias either.
            if isinstance(node, ast.Import):
                for alias in node.names:
                    assert alias.name.split(".")[0] != "subprocess", (
                        f"{rel} imports subprocess; it must go through revgate/git/exec.py"
                    )
            top = (node.module or "").split(".")[0] if isinstance(node, ast.ImportFrom) else ""
            if top == "subprocess":
                raise AssertionError(
                    f"{rel} imports from subprocess; it must go through revgate/git/exec.py"
                )
            if isinstance(node, ast.Call):
                func = node.func
                spawns = (
                    isinstance(func, ast.Attribute)
                    and isinstance(func.value, ast.Name)
                    and func.value.id == "subprocess"
                    and func.attr in {"Popen", "run", "call", "check_call", "check_output"}
                )
                assert not spawns, f"{rel} spawns a process directly; use revgate/git/exec.py"


def test_the_raw_git_runners_stay_inside_the_git_package() -> None:
    """The spawn rule cannot be side-stepped by importing the runner and calling it elsewhere.

    `find_repo_root` and the other wrappers are fair game outside the package —
    they already carry `HARDENED_CONFIG` with them.
    """
    for rel, tree in python_modules():
        if rel.startswith("git/"):
            continue
        for node in ast.walk(tree):
            # A whole-module import hands over every name at once, so it cannot
            # be inspected name by name: outside the package it is refused.
            if isinstance(node, ast.Import):
                for alias in node.names:
                    assert alias.name != EXEC_MODULE, (
                        f"{rel} takes {EXEC_MODULE} whole; import the named wrappers instead"
                    )
            if isinstance(node, ast.ImportFrom) and node.module == EXEC_MODULE:
                for alias in node.names:
                    assert alias.name != "*", f"{rel} star-imports {EXEC_MODULE}"
                    assert alias.name not in RAW_RUNNERS, (
                        f"{rel} imports {alias.name}() from {EXEC_MODULE}; "
                        "only the revgate.git package may"
                    )
