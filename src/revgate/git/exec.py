"""The one place this project spawns git.

`subprocess` imposes no ceiling on what a child may write, so stdout is read in
chunks against a byte cap here and the child is killed above it. A separate
thread drains stderr, because a git process blocked on a full stderr pipe never
exits, and `communicate()` cannot be used because the cap needs incremental
reads.
"""

import subprocess
import sys
import threading
from typing import IO, cast

#: 64 MB — diffs can be large, but a runaway child must not exhaust memory.
MAX_OUTPUT_BYTES = 64 * 1024 * 1024

_CHUNK = 64 * 1024

#: Only Windows has this flag; on POSIX there is no console to hide.
_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0

#: Config forced on every git invocation. Each key, left inherited, renames or
#: silently drops files from the review. See the git rule in agents.md.
HARDENED_CONFIG: list[str] = [
    part
    for key_value in (
        "core.quotePath=false",
        "diff.relative=false",
        "diff.noprefix=false",
        "diff.mnemonicPrefix=false",
        "diff.srcPrefix=a/",
        "diff.dstPrefix=b/",
        "status.showUntrackedFiles=normal",
    )
    for part in ("-c", key_value)
]


class GitError(Exception):
    """A git invocation that exited non-zero, or whose output blew the cap."""

    def __init__(self, message: str, stderr: str = "") -> None:
        super().__init__(message)
        self.stderr = stderr


def _drain(stream: IO[bytes], sink: list[bytes]) -> None:
    """Read a pipe to EOF. Runs on its own thread so git never blocks on a full pipe."""
    sink.append(stream.read())


def git(cwd: str, args: list[str]) -> str:
    """Run git in `cwd` and return its stdout. Internal to `revgate.git`."""
    with subprocess.Popen(
        # `git` is resolved on PATH; the argv never reaches a shell.
        ["git", *HARDENED_CONFIG, *args],  # noqa: S607
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        # An inherited stdin lets git prompt for a credential or a passphrase.
        # That prompt hangs the blocking hook forever, with no terminal to
        # answer it.
        stdin=subprocess.DEVNULL,
        # No `text=True` and no `encoding=`: universal newlines would translate
        # CRLF to LF, and the diff parser needs CR exactly where git wrote it.
        creationflags=_CREATE_NO_WINDOW,
    ) as process:
        # `stdout=PIPE` and `stderr=PIPE` guarantee both pipes exist.
        stdout_pipe = cast("IO[bytes]", process.stdout)
        stderr_chunks: list[bytes] = []
        drainer = threading.Thread(
            target=_drain, args=(cast("IO[bytes]", process.stderr), stderr_chunks), daemon=True
        )
        drainer.start()

        out = bytearray()
        overflowed = False
        while chunk := stdout_pipe.read(_CHUNK):
            out += chunk
            if len(out) > MAX_OUTPUT_BYTES:
                overflowed = True
                break
        if overflowed:
            process.kill()
        stdout_pipe.close()
        code = process.wait()
        # Joined before the `with` block closes the stderr pipe under the thread.
        drainer.join()

    stderr = b"".join(stderr_chunks).decode("utf-8", errors="replace")
    if overflowed:
        raise GitError(f"git {args[0] if args else ''} output exceeded {MAX_OUTPUT_BYTES} bytes")
    if code != 0:
        raise GitError(f"git exited with code {code}", stderr)
    return bytes(out).decode("utf-8", errors="replace")


def git_diff(cwd: str, args: list[str]) -> str:
    """`git diff` with `diff.external` forced off — the one setting `-c` cannot disable."""
    return git(cwd, ["diff", "--no-ext-diff", "--no-color", *args])


def git_error_message(err: object, fallback: str) -> str:
    """A one-line reason from a failed git invocation, preferring git's own `fatal:` line."""
    stderr = getattr(err, "stderr", None)
    if isinstance(stderr, str):
        for raw in stderr.splitlines():
            line = raw.strip()
            if line:
                return f"{fallback}: {line}"
    return fallback


def has_head(cwd: str) -> bool:
    """True if the repo has at least one commit (so HEAD resolves)."""
    try:
        git(cwd, ["rev-parse", "--verify", "HEAD"])
    except Exception:  # noqa: BLE001 — any failure means "no HEAD"; this is a probe, not a command
        return False
    return True


def is_git_repo(cwd: str) -> bool:
    """True if `cwd` sits inside a git work tree."""
    try:
        git(cwd, ["rev-parse", "--is-inside-work-tree"])
    except Exception:  # noqa: BLE001 — a missing directory or a missing git both mean "not a repo"
        return False
    return True


def find_repo_root(cwd: str) -> str | None:
    """Absolute path to the repository root, or None when `cwd` is not inside a work tree."""
    try:
        out = git(cwd, ["rev-parse", "--show-toplevel"]).strip()
    except Exception:  # noqa: BLE001 — the caller only ever asks "is there a root, yes or no"
        return None
    return out or None


def repo_root(cwd: str) -> str:
    """The repository root, falling back to `cwd`.

    Every revgate path is root-relative, and `ls-files --others` and
    `add`/`reset` resolve against the cwd.
    """
    return find_repo_root(cwd) or cwd
