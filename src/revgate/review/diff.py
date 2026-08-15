"""A minimal unified-diff parser tuned for `git diff` output.

The most intricate logic in the project. It handles new, deleted, renamed and
binary files and standard `@@` hunks, and it refuses any file whose path carries
a line break — everything downstream is line-oriented, so such a path splices
phantom records. See the path-splicing rule in agents.md.
"""

import re
from collections.abc import Callable

from revgate.shared.jsonio import dumps_compact
from revgate.shared.log import warn
from revgate.shared.types import DiffFile, DiffHunk, DiffLine

#: The C escapes git emits in a quoted path, mapped to the byte they stand for.
C_ESCAPES: dict[str, int] = {
    "a": 0x07,
    "b": 0x08,
    "f": 0x0C,
    "n": 0x0A,
    "r": 0x0D,
    "t": 0x09,
    "v": 0x0B,
    '"': 0x22,
    "\\": 0x5C,
}

_OCTAL = frozenset("01234567")
#: git writes a byte as exactly three octal digits, e.g. `Ã`.
_OCTAL_DIGITS = 3
#: The shortest quoted token is the pair of quotes itself.
_MIN_QUOTED_LEN = 2

_HEADER_RE = re.compile(r'^diff --git ("?)a/(.+?)\1 ("?)b/(.+)\3$')
_HUNK_RE = re.compile(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$")
_LINE_BREAK_RE = re.compile(r"[\r\n]")


def unquote_git_path(quoted: str) -> str:
    """Decode the body of a git-quoted path (the text between the double quotes).

    The escapes are `\\NNN` *octal bytes*, so they are collected into a buffer
    and decoded as UTF-8 in one go: a single `é` arrives as `\\303\\251`.

    The scan walks code points, not UTF-16 units, so a non-BMP character
    survives instead of being re-encoded from a lone surrogate into U+FFFD.
    """
    out = bytearray()
    index = 0
    end = len(quoted)
    while index < end:
        char = quoted[index]
        if char != "\\":
            # Re-encode: the escapes above are bytes, so everything must be bytes.
            out += char.encode("utf-8", errors="replace")
            index += 1
            continue
        index += 1
        if index >= end:
            break  # trailing backslash — nothing to escape
        following = quoted[index]
        triple = quoted[index : index + 3]
        if len(triple) == _OCTAL_DIGITS and all(digit in _OCTAL for digit in triple):
            # Masked the way a byte array truncates: git never emits above \377.
            out.append(int(triple, 8) & 0xFF)
            index += 3
            continue
        known = C_ESCAPES.get(following)
        if known is not None:
            out.append(known)
        else:
            out += following.encode("utf-8", errors="replace")  # unknown: keep it
        index += 1
    return out.decode("utf-8", errors="replace")


def _unquote_if_quoted(path: str) -> str:
    """Undo git's path quoting if the token carries it; otherwise pass it through."""
    if len(path) >= _MIN_QUOTED_LEN and path.startswith('"') and path.endswith('"'):
        return unquote_git_path(path[1:-1])
    return path


def _has_line_break_in_path(diff_file: DiffFile) -> bool:
    """True if any of a file's paths carries a line break."""
    return any(
        _LINE_BREAK_RE.search(value)
        for value in (diff_file.path, diff_file.old_path, diff_file.new_path)
    )


def _strip_prefix(path: str) -> str:
    """Drop git's `a/` or `b/` prefix, unquoting first."""
    if path == "/dev/null":
        return path
    # Unquote BEFORE stripping: git quotes the whole token including the `a/`
    # prefix (`"a/caf\303\251.txt"`), so a quoted path does not start with `a/`.
    stripped = _unquote_if_quoted(path)
    if stripped.startswith(("a/", "b/")):
        return stripped[2:]
    return stripped


def parse_unified_diff(
    text: str, on_drop: Callable[[DiffFile], None] | None = None
) -> list[DiffFile]:
    """Parse `git diff` output. `on_drop` receives each file refused for an unsafe path."""
    lines = text.split("\n")
    # A trailing newline leaves a final empty element. It is not a context line:
    # taking it as one appends a blank row numbered one past the end of the file.
    if lines and lines[-1] == "":
        lines.pop()

    files: list[DiffFile] = []
    current: DiffFile | None = None
    hunk: DiffHunk | None = None
    old_line_no = 0
    new_line_no = 0

    def push_file() -> None:
        if current is None:
            return
        if _has_line_break_in_path(current):
            warn(f"skipping file whose name contains a newline: {dumps_compact(current.path)}")
            # Dropped, but not silently: if it was the only change, an empty diff
            # reads downstream as "nothing to review, approve".
            if on_drop is not None:
                on_drop(current)
            return
        files.append(current)

    for line in lines:
        if line.startswith("diff --git "):
            push_file()
            hunk = None
            # Fall back to the header's own paths until ---/+++ refine them. The
            # backreference keeps the two quote states independent, since a rename
            # can quote one path and not the other; the `\r` strip keeps a CRLF
            # line ending out of the guessed path, where it would trip the
            # line-break guard.
            match = _HEADER_RE.match(re.sub(r"\r+$", "", line))
            guess = ""
            old_guess = ""
            if match is not None:
                guess = unquote_git_path(match.group(4)) if match.group(3) else match.group(4)
                old_guess = unquote_git_path(match.group(2)) if match.group(1) else match.group(2)
            current = DiffFile(
                old_path=old_guess,
                new_path=guess,
                path=guess,
                is_new=False,
                is_deleted=False,
                is_renamed=False,
                is_binary=False,
                additions=0,
                deletions=0,
                hunks=[],
            )
            continue

        if current is None:
            continue

        if line.startswith("new file mode"):
            current.is_new = True
            continue
        if line.startswith("deleted file mode"):
            current.is_deleted = True
            continue
        if line.startswith("rename from "):
            current.is_renamed = True
            # Quoted like the header paths, but with no `a/`/`b/` prefix.
            current.old_path = _unquote_if_quoted(line[len("rename from ") :].strip())
            continue
        if line.startswith("rename to "):
            current.is_renamed = True
            current.new_path = _unquote_if_quoted(line[len("rename to ") :].strip())
            current.path = current.new_path
            continue
        if line.startswith(("Binary files", "GIT binary patch")):
            current.is_binary = True
            continue

        # Both header branches are gated on being OUTSIDE a hunk: inside one, a
        # deleted `-- ` line arrives as `--- …` and an added `++ ` line as `+++ …`,
        # and swallowing either as a path header renumbers the side and overwrites
        # `path`. git emits `---`/`+++` before the first `@@`, so `hunk is None`
        # admits exactly the real headers.
        if hunk is None and line.startswith("--- "):
            path = _strip_prefix(line[4:].strip())
            current.old_path = path
            if path == "/dev/null":
                current.is_new = True
            continue
        if hunk is None and line.startswith("+++ "):
            path = _strip_prefix(line[4:].strip())
            current.new_path = path
            if path == "/dev/null":
                current.is_deleted = True
            else:
                current.path = path
            continue

        if line.startswith("@@"):
            match = _HUNK_RE.match(line)
            old_line_no = int(match.group(1)) if match is not None else 0
            new_line_no = int(match.group(2)) if match is not None else 0
            hunk = DiffHunk(header=line, old_start=old_line_no, new_start=new_line_no, lines=[])
            current.hunks.append(hunk)
            continue

        if hunk is None:
            continue

        if line.startswith("\\"):
            continue  # "\ No newline at end of file" — attaches to nothing

        tag = line[0] if line else ""
        content = line[1:]
        entry: DiffLine | None = None
        if tag == "+":
            entry = DiffLine(type="add", content=content, old_line=None, new_line=new_line_no)
            new_line_no += 1
            current.additions += 1
        elif tag == "-":
            entry = DiffLine(type="del", content=content, old_line=old_line_no, new_line=None)
            old_line_no += 1
            current.deletions += 1
        elif tag == " " or line == "":
            entry = DiffLine(
                type="context", content=content, old_line=old_line_no, new_line=new_line_no
            )
            old_line_no += 1
            new_line_no += 1
        if entry is not None:
            hunk.lines.append(entry)

    push_file()
    return files
