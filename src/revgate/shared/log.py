"""Logging. Every line goes to stderr, because stdout carries an output contract."""

import sys


def log(*args: object) -> None:
    """Log to stderr."""
    # `sys.stderr` is resolved here, not bound at import: a test that swaps the
    # stream (pytest's `capsys` does) must see its own object, not the original.
    sys.stderr.write(f"[revgate] {' '.join(str(a) for a in args)}\n")


def warn(*args: object) -> None:
    """Warn to stderr, under the same rule as `log`."""
    sys.stderr.write(f"[revgate] WARN {' '.join(str(a) for a in args)}\n")
