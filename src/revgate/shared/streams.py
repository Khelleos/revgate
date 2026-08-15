"""stdout discipline.

stdout carries an output contract that Copilot parses byte for byte. Python on
Windows writes CRLF and encodes with cp1252 by default, and either one breaks
every contract in the project. This module is the single place that fixes that.
"""

import sys
from typing import TextIO


def _reconfigure(stream: TextIO) -> None:
    """Pin one stream to UTF-8 with no newline translation.

    `newline=""` stops the CRLF translation. `errors="replace"` is deliberate:
    on the hook path a `UnicodeEncodeError` would exit non-zero and fail the
    gate *closed*, which denies the Copilot tool call. A U+FFFD is the better
    failure. A stream that pytest has swapped for its own capture object has no
    `reconfigure`, so this is a no-op there rather than an error.
    """
    reconfigure = getattr(stream, "reconfigure", None)
    if reconfigure is None:
        return
    reconfigure(encoding="utf-8", newline="", errors="replace")


def configure_stdio() -> None:
    """Put stdout and stderr on the contract. Call from `main()` only.

    Never at import time: that would reconfigure the streams pytest hands to
    `capsys` and break capture for every test in the process.
    """
    _reconfigure(sys.stdout)
    _reconfigure(sys.stderr)


def write_stdout(text: str) -> None:
    """Write to stdout, resolving `sys.stdout` at call time so tests can swap it."""
    sys.stdout.write(text)


def flush_stdio() -> None:
    """Flush both streams. A hook that exits with a buffered verdict emits nothing."""
    sys.stdout.flush()
    sys.stderr.flush()
