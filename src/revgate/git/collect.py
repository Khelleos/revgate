"""Collecting one scope's unified diff, plus what could not be collected."""

import re
from dataclasses import dataclass, field

from revgate.git.exec import git, git_diff, git_error_message, has_head, is_git_repo, repo_root
from revgate.git.scope import DiffScope, ScopeError, describe_scope, verify_arity, verify_ref
from revgate.git.untracked import new_untracked_budget, untracked_file_diff
from revgate.review.diff import parse_unified_diff
from revgate.shared.jsonio import dumps_compact
from revgate.shared.log import warn

_LINE_BREAK_RE = re.compile(r"[\r\n]")


@dataclass(slots=True)
class RepoDiff:
    """One scope's collected diff, plus what could not be collected."""

    is_repo: bool
    #: Concatenated unified diff text for all changes (tracked + untracked).
    unified: str
    branch: str | None
    #: Untracked paths synthesized into the diff.
    untracked: list[str] = field(default_factory=list)
    scope_label: str = ""
    #: True when the untracked scan failed, so this diff covers tracked changes only.
    untracked_scan_failed: bool = False
    #: How many untracked files were dropped for a line break in their name.
    dropped_untracked: int = 0


def collect_diff(cwd: str, scope: DiffScope) -> RepoDiff:
    """Collect the unified diff for `scope`, raising ScopeError if a ref does not resolve.

    Untracked files are synthesized for the worktree scope ONLY, since a ref,
    range or staged review is about committed or indexed content.
    """
    verify_arity(scope)
    scope_label = describe_scope(scope)

    if not is_git_repo(cwd):
        return RepoDiff(
            is_repo=False, unified="", branch=None, untracked=[], scope_label=scope_label
        )

    branch: str | None = None
    try:
        branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).strip()
    except Exception:  # noqa: BLE001 — detached HEAD or no commits; the header just omits it
        branch = None

    for ref in scope.refs:
        verify_ref(cwd, ref)

    # The trailing `--` keeps a ref that names a file from becoming a pathspec.
    tracked = ""
    try:
        if scope.kind == "staged":
            tracked = git_diff(cwd, ["--cached", "--"])
        elif scope.kind == "ref":
            tracked = git_diff(cwd, [scope.refs[0], "--"])
        elif scope.kind == "range":
            tracked = git_diff(
                cwd,
                [f"{scope.refs[0]}...{scope.refs[1]}", "--"]
                if scope.dots == "..."
                else [scope.refs[0], scope.refs[1], "--"],
            )
        elif has_head(cwd):
            # Working tree vs HEAD captures both staged and unstaged changes.
            tracked = git_diff(cwd, ["HEAD", "--"])
        else:
            # Fresh repo, no commits yet: staged changes are the only tracked diff.
            try:
                tracked = git_diff(cwd, ["--cached", "--"])
            except Exception:  # noqa: BLE001 — nothing staged in a fresh repo is not an error
                tracked = ""
    except Exception as err:
        # Every ref cleared individually already, so a failure here is the
        # *combination* being unusable. That is bad usage: exit 2, not a stack trace.
        raise ScopeError(git_error_message(err, f"could not diff {scope_label}")) from err

    untracked: list[str] = []
    untracked_scan_failed = False
    dropped_untracked = 0
    # From the root, so the paths match the root-relative ones `git diff` emitted.
    root = repo_root(cwd)
    if scope.kind == "worktree":
        try:
            # `-z` for the same reason as `status`: the newline form is C-quoted
            # for non-ASCII paths, and a quoted name resolves on nothing.
            out = git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
        except Exception as err:  # noqa: BLE001 — carried in the result, never swallowed
            # Swallowed, this drops *every* untracked file at once, which reads
            # downstream as "nothing to review, approve". Say it, and carry it.
            untracked_scan_failed = True
            warn(git_error_message(err, "could not list untracked files"))
        else:
            for path in out.split("\0"):
                if not path:
                    continue
                if not _LINE_BREAK_RE.search(path):
                    untracked.append(path)
                    continue
                # Counted, not just warned: dropping the only changed file must
                # reach the report, never read as an empty-diff approval.
                dropped_untracked += 1
                warn(
                    f"skipping untracked file whose name contains a newline: {dumps_compact(path)}"
                )

    # A path can appear in BOTH lists (`git rm --cached x`). Two DiffFiles with one
    # `path` double-count it and make a lookup by path hit the deleted entry.
    if untracked and tracked.strip():
        in_tracked = {f.path for f in parse_unified_diff(tracked)}
        untracked = [p for p in untracked if p not in in_tracked]

    parts: list[str] = []
    if tracked.strip():
        parts.append(tracked)
    # One allowance shared by the whole set — see MAX_UNTRACKED_TOTAL_BYTES.
    budget = new_untracked_budget()
    for path in untracked:
        synthesized = untracked_file_diff(root, path, budget)
        if synthesized:
            parts.append(synthesized)
    if budget.elided > 0:
        # Once: a per-file line would itself be the flood.
        warn(
            f"{budget.elided} untracked file(s) listed without a diff — "
            f"this review hit its untracked-content budget"
        )

    return RepoDiff(
        is_repo=True,
        unified="".join(parts),
        branch=branch,
        untracked=untracked,
        scope_label=scope_label,
        untracked_scan_failed=untracked_scan_failed,
        dropped_untracked=dropped_untracked,
    )
