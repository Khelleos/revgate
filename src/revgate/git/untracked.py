"""Synthesizing an "all added" diff for an untracked file.

`git diff HEAD` never reports one, so the reviewer would approve a new file
without ever seeing it. Past any budget the file is listed unexpanded — never
dropped, for the same reason.
"""

import re
import stat
from dataclasses import dataclass
from pathlib import Path

from revgate.shared.log import warn

#: Largest untracked file inlined into the review; above this it is listed only.
MAX_UNTRACKED_BYTES = 2 * 1024 * 1024

#: Ceilings across *all* untracked files in one review; see agents.md.
MAX_UNTRACKED_TOTAL_BYTES = 8 * 1024 * 1024
#: Same reasoning, for a wide tree of small files that never reaches the byte total.
MAX_UNTRACKED_FILES = 300

_LINE_BREAK_RE = re.compile(r"[\r\n]")


def looks_binary(buf: bytes) -> bool:
    """Heuristic mirroring git: a NUL byte in the first 8KB => treat as binary."""
    return b"\0" in buf[:8000]


@dataclass(slots=True)
class UntrackedBudget:
    """Remaining allowance for one `collect_diff` call, spent by `untracked_file_diff`.

    Mutable on purpose: it is one shared allowance that each file decrements.
    """

    bytes: int
    files: int
    #: How many paths were listed unexpanded because the budget ran out.
    elided: int = 0


def new_untracked_budget() -> UntrackedBudget:
    """A fresh allowance shared by every untracked file in one review."""
    return UntrackedBudget(bytes=MAX_UNTRACKED_TOTAL_BYTES, files=MAX_UNTRACKED_FILES)


def untracked_file_diff(  # noqa: PLR0911 — each return is a distinct "listed unexpanded" case
    cwd: str, rel_path: str, budget: UntrackedBudget
) -> str:
    """Return the synthesized diff for one untracked path."""
    # Lexical join only: `Path.resolve()` would follow a symlink, and this code
    # deliberately reports the link itself rather than its target.
    absolute = Path(cwd) / rel_path

    def header_for(mode: str) -> str:
        # A symlink announced as a regular file lies about what a commit would add.
        return (
            f"diff --git a/{rel_path} b/{rel_path}\n"
            f"new file mode {mode}\n"
            f"--- /dev/null\n"
            f"+++ b/{rel_path}\n"
        )

    header = header_for("100644")
    # How the UI renders "present in the review, but not expanded".
    binary_line = f"Binary files /dev/null and b/{rel_path} differ\n"
    unexpanded = header + binary_line

    try:
        # Size before content, and `lstat` before the budget: the budget decides
        # whether a path is *expanded*, never what it *is*. See agents.md.
        info = absolute.lstat()
        is_link = stat.S_ISLNK(info.st_mode)
        if budget.files <= 0:
            budget.elided += 1
            return header_for("120000" if is_link else "100644") + binary_line
        if is_link:
            # A link's `lstat` size is its target's length, which is what gets inlined.
            budget.bytes -= info.st_size
            budget.files -= 1
            target = str(absolute.readlink())
            # The target becomes diff content, so a line break in it splices a record.
            if _LINE_BREAK_RE.search(target):
                warn(
                    f"untracked symlink {rel_path} points at a path containing a newline — "
                    f"listing it without a diff"
                )
                return header_for("120000") + binary_line
            # Exactly what `git diff` emits for a new symlink.
            return (
                header_for("120000") + f"@@ -0,0 +1 @@\n+{target}\n\\ No newline at end of file\n"
            )
        if not stat.S_ISREG(info.st_mode):
            # A FIFO, socket or device node: reading one blocks or never ends.
            warn(f"untracked path {rel_path} is not a regular file — listing it without a diff")
            return unexpanded
        if info.st_size > MAX_UNTRACKED_BYTES:
            warn(f"untracked file {rel_path} is {info.st_size} bytes — listing it without a diff")
            return unexpanded
        if info.st_size > budget.bytes:
            budget.elided += 1
            return unexpanded
        buf = absolute.read_bytes()
        # Charged before the checks below: the read already cost the memory.
        budget.bytes -= info.st_size
        budget.files -= 1
    except OSError as err:
        # Listed unexpanded, never dropped: a file that leaves the review is one
        # the reviewer approved without seeing.
        warn(f"could not read untracked file {rel_path}: {err}")
        return unexpanded

    if looks_binary(buf):
        return unexpanded

    text = buf.decode("utf-8", errors="replace")
    raw_lines = text.split("\n")
    if raw_lines and raw_lines[-1] == "":
        raw_lines.pop()
    if not raw_lines:
        return header  # empty new file — nothing to show

    hunk = f"@@ -0,0 +1,{len(raw_lines)} @@\n"
    body = "\n".join(f"+{line}" for line in raw_lines) + "\n"
    no_newline_at_eof = not text.endswith("\n")
    return header + hunk + body + ("\\ No newline at end of file\n" if no_newline_at_eof else "")
