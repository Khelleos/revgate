"""Which changes a review covers, and how a scope is labelled and filtered."""

import re
from dataclasses import dataclass, field
from typing import Literal

from revgate.git.exec import git
from revgate.shared.types import DiffFile

ScopeKind = Literal["worktree", "staged", "ref", "range"]
Dots = Literal["..", "..."]

_LINE_BREAKS = re.compile(r"[\r\n]+")


@dataclass(slots=True)
class DiffScope:
    """Declared once, so the parser and the collector cannot drift."""

    kind: ScopeKind
    #: `[]` for worktree/staged, `[ref]` for a single ref, `[a, b]` for a range.
    refs: list[str] = field(default_factory=list)
    #: ".." compares the endpoints, "..." compares from the merge base.
    dots: Dots | None = None
    #: Path prefixes to keep (empty keeps all) and to drop.
    include: list[str] = field(default_factory=list)
    exclude: list[str] = field(default_factory=list)


class ScopeError(Exception):
    """A scope git cannot honour.

    Distinct from a crash, so callers report bad usage (exit 2).
    """


def describe_scope(scope: DiffScope) -> str:
    """The label shown in the UI header, in log lines, and as the report's `scope:`."""
    if scope.kind == "staged":
        label = "staged changes"
    elif scope.kind == "ref":
        label = f"{scope.refs[0]} vs working tree"
    elif scope.kind == "range":
        label = f"{scope.refs[0]}{scope.dots or '..'}{scope.refs[1]}"
    else:
        label = "working tree vs HEAD"

    # Filters belong in the label: they are why a busy scope can come back empty.
    # The label is the report's `scope:` header verbatim, so a filter, which is
    # user text, must not carry a line break into it.
    def one_line(value: str) -> str:
        return _LINE_BREAKS.sub(" ", value)

    filters = [f"+{one_line(p)}" for p in scope.include if p]
    filters += [f"-{one_line(p)}" for p in scope.exclude if p]
    return f"{label} [{' '.join(filters)}]" if filters else label


def verify_arity(scope: DiffScope) -> None:
    """Check a scope carries the refs its kind implies; a missing one would crash the spawn."""
    want = 1 if scope.kind == "ref" else 2 if scope.kind == "range" else 0
    if len(scope.refs) != want:
        raise ScopeError(f"a {scope.kind} scope needs exactly {want} ref(s), got {len(scope.refs)}")


def verify_ref(cwd: str, ref: str) -> None:
    """Resolve a ref before `git diff` sees it, so a typo is bad usage and not a git crash."""
    # A leading dash would be read by git as a flag.
    if not ref or ref.startswith("-"):
        raise ScopeError(f"invalid git ref: {ref or '(empty)'}")
    try:
        git(cwd, ["rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"])
    except Exception as err:
        raise ScopeError(f"unknown git ref: {ref}") from err


def _normalize_path(path: str) -> str:
    """Compare paths with forward slashes so a Windows-style prefix still matches."""
    return path.replace("\\", "/")


def _normalize_prefix(prefix: str) -> str:
    """Reduce a `-I`/`-X` prefix to the root-relative form `git diff` emits; `""` is the tree."""
    clean = _normalize_path(prefix).rstrip("/")
    while clean.startswith("./"):
        clean = clean[2:]
    if clean == ".":
        return ""
    return clean.lstrip("/")


def _matches_prefix(path: str, prefix: str) -> bool:
    """Does `path` sit at or under `prefix`?

    A raw prefix test over-excludes on a string boundary.
    """
    clean = _normalize_prefix(prefix)
    if not clean:
        return True
    return path == clean or path.startswith(f"{clean}/")


def filter_files(files: list[DiffFile], scope: DiffScope) -> list[DiffFile]:
    """Narrow a parsed diff: include first, then exclude from what survived."""
    include = [p for p in map(_normalize_path, scope.include) if p]
    exclude = [p for p in map(_normalize_path, scope.exclude) if p]
    if not include and not exclude:
        return files

    kept = []
    for diff_file in files:
        path = _normalize_path(diff_file.path)
        if include and not any(_matches_prefix(path, prefix) for prefix in include):
            continue
        if any(_matches_prefix(path, prefix) for prefix in exclude):
            continue
        kept.append(diff_file)
    return kept
