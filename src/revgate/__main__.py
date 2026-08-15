"""Entry point, dispatch only.

Every piece of logic lives in `revgate.cli`, which is what makes it testable:
this file only routes, and owns the outermost fail-open handler.
"""

import sys

import click

from revgate.cli.command import cli
from revgate.cli.grammar import parse_args
from revgate.cli.plan_hook import emit_permission
from revgate.shared.log import warn
from revgate.shared.streams import configure_stdio, flush_stdio


def main() -> int:
    """The console-script target. Returns a process exit code; never raises."""
    # First, before anything can write a byte: stdout is a contract, and Python
    # on Windows would otherwise encode it as cp1252 with CRLF line endings.
    configure_stdio()
    argv = sys.argv[1:]
    try:
        result = cli.main(args=argv, standalone_mode=False)
        code = result if isinstance(result, int) else 0
    except click.UsageError as err:
        warn(str(err))
        code = 2
    except click.Abort, KeyboardInterrupt:
        code = 1
    # `BaseException`, not `Exception`: a MemoryError or a SystemExit raised deep
    # inside must still leave the gate open rather than deny the tool.
    except BaseException as err:  # noqa: BLE001
        warn(f"fatal: {err!r}")
        code = _fail_open(argv)
    flush_stdio()
    return code


def _fail_open(argv: list[str]) -> int:
    """The exit code and stdout a crashed run owes, by command."""
    try:
        command = parse_args(argv).command
    except BaseException:  # noqa: BLE001 — even the re-parse must not deny the tool
        command = "plan" if argv[:1] == ["plan"] else "review"
    if command == "review":
        return 1
    # The hook must fail open: a non-zero exit denies the tool.
    emit_permission({"permissionDecision": "allow"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
