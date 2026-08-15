"""Reading and toggling the index state of a reviewed path."""

from revgate.git.exec import git, git_error_message, repo_root
from revgate.shared.log import warn
from revgate.shared.types import StageState

#: `XY path`: two status columns, a space, then the path.
_RECORD_PREFIX_LEN = 3


def _is_unmerged(x: str, y: str) -> bool:
    """The `git status` column pairs that mean "conflict" — see the staging rule in agents.md."""
    return x == "U" or y == "U" or (x == "A" and y == "A") or (x == "D" and y == "D")


def get_stage_states(cwd: str) -> dict[str, StageState]:
    """Whether each changed path's changes are staged, from `git status --porcelain`.

    The two columns are X (index vs HEAD) and Y (working tree vs index).
    """
    states: dict[str, StageState] = {}
    try:
        # NUL-terminated records: the only form git emits verbatim.
        out = git(cwd, ["status", "--porcelain=v1", "-z"])
    except Exception as err:  # noqa: BLE001 — an unreadable status is "no states", not a crash
        warn(f"could not read git status: {err}")
        return states

    tokens = out.split("\0")
    index = 0
    while index < len(tokens):
        record = tokens[index]
        index += 1
        if len(record) < _RECORD_PREFIX_LEN:
            continue
        x = record[0]
        y = record[1]
        path = record[_RECORD_PREFIX_LEN:]
        # A rename/copy carries its origin in the NEXT NUL field, on either column.
        # Unskipped, that origin parses as a record whose bogus key overwrites a real one.
        if x in {"R", "C"} or y in {"R", "C"}:
            index += 1

        if x == "?":
            # `git rm --cached x` leaves both a tracked and an untracked record, and
            # git emits `??` last. The tracked one describes the index, so it stands.
            if path not in states:
                states[path] = "no"  # untracked — nothing staged
        elif _is_unmerged(x, y):
            states[path] = "unmerged"  # a conflict: staging is not a meaningful action
        elif x != " " and y != " ":
            states[path] = "partial"  # staged, but the working tree diverged again
        elif x != " ":
            states[path] = "yes"  # fully staged
        else:
            states[path] = "no"  # only a working-tree change
    return states


def set_staged(cwd: str, file: str, staged: bool) -> dict[str, StageState]:
    """Stage or unstage one path, returning refreshed states.

    A rename can reclassify neighbours, so the whole map is re-read.
    """
    # `file` is root-relative and git resolves a pathspec against the cwd.
    root = repo_root(cwd)
    try:
        if staged:
            # `add` handles modified, new, and deleted paths alike.
            git(root, ["add", "--", file])
        else:
            # `reset` unstages whether or not HEAD exists (fresh repos included).
            git(root, ["reset", "-q", "--", file])
    except Exception as err:
        # Propagated: a 200 with unchanged states cannot say "git refused".
        action = "stage" if staged else "unstage"
        raise RuntimeError(git_error_message(err, f"could not {action} {file}")) from err
    return get_stage_states(root)
