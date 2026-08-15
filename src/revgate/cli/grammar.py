"""argv parsing for every revgate entry point.

The `review` command reports usage errors honestly; the `plan` hook has a
fail-open contract and so must never reject argv.

Click owns the process, but the grammar lives here: this parser never raises, it
keeps only the *first* error and keeps parsing after it, so `review --bogus
--help` still prints the help text and still exits 2. Click stops at the first
error and writes different messages, and reproducing this inside it would mean
overriding methods Click 8.2 made private.
"""

from dataclasses import dataclass, field
from typing import Literal

from revgate.git.scope import DiffScope

Command = Literal["plan", "review"]

#: Positionals past this many are an error; the first two are refs.
_MAX_REFS = 2


@dataclass(slots=True)
class CliOptions:
    """Everything a parsed command line carries."""

    #: `DiffScope` itself, not an alias, so the parser produces exactly the
    #: shape `collect_diff` consumes.
    scope: DiffScope = field(default_factory=lambda: DiffScope(kind="worktree"))
    #: False when `--no-open` was passed.
    open: bool = True
    #: `--plan` was passed: review a plan document instead of a diff.
    plan: bool = False
    #: The optional path given to `--plan`.
    plan_file: str | None = None
    #: `--output <file>` / `-o`: write annotations here instead of stdout.
    output: str | None = None
    #: `--exit-code-on-comments`: exit 10 when the review captured anything.
    exit_code_on_comments: bool = False
    #: False when `--no-history` was passed: don't persist the review.
    history: bool = True
    #: `--history-dir <dir>`: where to persist reviews (beats $REVGATE_HISTORY_DIR).
    history_dir: str | None = None
    #: `--help` / `-h`.
    help: bool = False


@dataclass(slots=True)
class ParsedArgs:
    """The command to run, and why it is unusable."""

    command: Command
    options: CliOptions
    error: str | None = None


def _split_range(arg: str) -> tuple[list[str], Literal["..", "..."]] | None:
    """Split `a..b` / `a...b`, defaulting an omitted side to HEAD the way git does."""
    three = arg.find("...")
    if three != -1:
        return ([arg[:three] or "HEAD", arg[three + 3 :] or "HEAD"], "...")
    two = arg.find("..")
    if two != -1:
        return ([arg[:two] or "HEAD", arg[two + 2 :] or "HEAD"], "..")
    return None


@dataclass(slots=True)
class _ParseResult:
    options: CliOptions
    error: str | None
    positionals: list[str]


def _parse_options(rest: list[str]) -> _ParseResult:
    """The flag/positional loop shared by every entry point. Never raises."""
    options = CliOptions()
    positionals: list[str] = []
    staged = False
    error: str | None = None

    def fail(message: str) -> None:
        """Keep the FIRST problem — it is the one that explains the rest."""
        nonlocal error
        if error is None:
            error = message

    # An explicit `while` with `nonlocal i`: a `for i in range(...)` loop would
    # silently discard the increments the value-taking branches make.
    index = 0
    while index < len(rest):
        raw = rest[index]

        # Long flags may carry their value inline as `--flag=value`. Long only:
        # `-o=x` falls through and is reported as `unknown flag: -o=x`.
        name = raw
        inline: str | None = None
        if raw.startswith("--"):
            equals = raw.find("=")
            if equals != -1:
                name = raw[:equals]
                inline = raw[equals + 1 :]

        def take_value(name: str = name, inline: str | None = inline) -> str | None:
            """Read a required value, either inline or from the next token.

            The values are hoisted into default arguments rather than closed
            over: the loop rebinds them every turn, and a late read would see
            the wrong token.
            """
            nonlocal index
            if inline is not None:
                if not inline:
                    fail(f"{name} requires a value")
                return inline or None
            following = rest[index + 1] if index + 1 < len(rest) else None
            # A value token that starts with `-` is refused and NOT consumed.
            if following is None or following.startswith("-"):
                fail(f"{name} requires a value")
                return None
            index += 1
            # An empty token is consumed and then refused, the same non-value as
            # `--flag=`: a skill interpolating an unset variable (`-o "$OUT"`,
            # `-I "$SCOPE"`) must not silently get behaviour it did not ask for.
            if not following:
                fail(f"{name} requires a value")
                return None
            return following

        def reject_value(name: str = name, inline: str | None = inline) -> None:
            """Refuse `--flag=value` on a switch that takes no value.

            Accepting and discarding it inverts the caller's intent in silence:
            an LLM readily writes `--no-history=false` meaning "keep history".
            """
            if inline is not None:
                fail(f"{name} does not take a value")

        if name in ("-h", "--help"):
            reject_value()
            options.help = True
        elif name == "--no-open":
            reject_value()
            options.open = False
        elif name == "--staged":
            reject_value()
            staged = True
        elif name in ("-I", "--include"):
            value = take_value()
            if value:
                options.scope.include.append(value)
        elif name in ("-X", "--exclude"):
            value = take_value()
            if value:
                options.scope.exclude.append(value)
        elif name in ("-o", "--output"):
            value = take_value()
            if value:
                options.output = value
        elif name == "--exit-code-on-comments":
            reject_value()
            options.exit_code_on_comments = True
        elif name == "--no-history":
            reject_value()
            options.history = False
        elif name == "--history-dir":
            value = take_value()
            if value:
                options.history_dir = value
        elif name == "--plan":
            options.plan = True
            if inline is not None:
                if inline:
                    options.plan_file = inline
                else:
                    fail("--plan= requires a path")
            else:
                # The path is OPTIONAL: only a following non-flag token counts.
                following = rest[index + 1] if index + 1 < len(rest) else None
                if following is not None and not following.startswith("-"):
                    # Consumed either way, so an empty token cannot be reported
                    # as a bad subcommand — but an empty one is not a path, and
                    # recording it would suppress the $REVGATE_PLAN_FILE fallback.
                    if following:
                        options.plan_file = following
                    index += 1
        elif raw.startswith("-") and raw != "-":
            fail(f"unknown flag: {raw}")
        else:
            positionals.append(raw)

        index += 1

    scope = options.scope
    if len(positionals) > _MAX_REFS:
        fail(f"unexpected argument: {positionals[_MAX_REFS]}")

    refs = positionals[:_MAX_REFS]
    if len(refs) == 1:
        split = _split_range(refs[0])
        if split is not None:
            scope.kind = "range"
            scope.refs, scope.dots = split
        else:
            scope.kind = "ref"
            scope.refs = [refs[0]]
    elif len(refs) == _MAX_REFS:
        scope.kind = "range"
        scope.refs = refs
        scope.dots = ".."

    if staged:
        if scope.kind == "worktree":
            scope.kind = "staged"
        else:
            fail("--staged cannot be combined with refs")

    # A plan review has no git diff behind it, so the scope is discarded. Saying
    # so beats silently reviewing something other than what the caller asked for.
    if options.plan and (staged or refs or scope.include or scope.exclude):
        fail(
            "--plan reviews a plan document, not a diff — "
            "it cannot be combined with refs, --staged, -I or -X"
        )

    return _ParseResult(options=options, error=error, positionals=positionals)


def parse_args(argv: list[str]) -> ParsedArgs:
    """Parse the argument vector. Never raises.

    A malformed `review` invocation comes back as `error`, which the caller
    turns into exit 2.
    """
    # The plan gate is recognized before ANY validation: it is a hook, and a
    # usage error there would fail closed and silently deny an unrelated tool.
    # Its flags still apply; only the *reporting* of a bad one is dropped.
    if argv and argv[0] == "plan":
        return ParsedArgs(command="plan", options=_parse_options(argv[1:]).options)

    is_review = bool(argv) and argv[0] == "review"
    parsed = _parse_options(argv[1:] if is_review else argv)

    if is_review:
        return ParsedArgs(command="review", options=parsed.options, error=parsed.error)

    # `revgate --help` with nothing else is a legitimate ask for usage.
    if not parsed.positionals and parsed.options.help and parsed.error is None:
        return ParsedArgs(command="review", options=parsed.options)

    # Everything else without the `review` subcommand is bad usage: there is no
    # hook left to fall through to, and a typo or a legacy hook invocation must
    # not open a review or forge a clean one.
    reason = (
        f"unknown command: {parsed.positionals[0]}"
        if parsed.positionals
        else "missing the `review` subcommand — the agentStop hook entry was removed; "
        "re-run install.ps1 if a hook still invokes bare `revgate`"
    )
    return ParsedArgs(command="review", options=parsed.options, error=parsed.error or reason)
