"""The Click shell.

Click owns the process; the grammar in `grammar.py` owns the parse. Only public
Click API is touched — `click.Command`, `click.Context`, `click.UsageError`,
`click.Abort` and `Command.main(standalone_mode=False)` — because reproducing
the grammar's "never raise, keep the first error, keep parsing" behaviour inside
Click's own parser would mean overriding methods it made private in 8.2.
"""

from typing import Any

import click

from revgate.cli.grammar import ParsedArgs, parse_args
from revgate.cli.help import help_text
from revgate.cli.plan_hook import run_plan_hook
from revgate.cli.review_command import run_review_command
from revgate.git.scope import ScopeError
from revgate.shared.log import warn
from revgate.shared.streams import write_stdout


def dispatch(parsed: ParsedArgs) -> int:
    """Run the parsed command line and return its exit code."""
    if parsed.command == "plan":
        run_plan_hook(parsed.options)
        return 0

    # A bad command line stays bad with --help appended: an agent recovering
    # from a usage error that way must not read exit 0 as success.
    if parsed.error:
        warn(parsed.error)
        if parsed.options.help:
            write_stdout(help_text())
        else:
            warn("run `revgate review --help` for usage")
        return 2

    # stdout is right here: no hook passes --help, and nothing else has used it.
    if parsed.options.help:
        write_stdout(help_text())
        return 0

    try:
        return run_review_command(parsed.options)
    except ScopeError as err:
        # A ref that doesn't resolve is bad usage, not a crash.
        warn(str(err))
        warn("run `revgate review --help` for usage")
        return 2


class RevgateCommand(click.Command):
    """A Click command whose parsing is ours and therefore never raises."""

    def parse_args(self, ctx: click.Context, args: list[str]) -> list[str]:
        """Hand the whole argument vector to our grammar, untouched."""
        ctx.params["parsed"] = parse_args(list(args))
        ctx.args = []
        return []


@click.command(
    cls=RevgateCommand,
    name="revgate",
    # `--help` prints our own byte-exact constant, so Click must not add its own
    # option and must not claim the name.
    add_help_option=False,
    context_settings={"help_option_names": [], "ignore_unknown_options": True},
)
def cli(**kwargs: Any) -> int:
    """revgate — human-in-the-loop, GitHub-style code review."""
    parsed: ParsedArgs = kwargs["parsed"]
    return dispatch(parsed)
