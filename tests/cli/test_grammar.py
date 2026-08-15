"""The argument grammar, ported token for token. Nothing here may raise."""

import re

import pytest

from revgate.cli.grammar import CliOptions, parse_args


def review(*argv: str) -> CliOptions:
    """`parse_args` for a `review` invocation, asserting it parsed cleanly."""
    parsed = parse_args(["review", *argv])
    assert parsed.command == "review"
    assert parsed.error is None, f"unexpected error for {argv!r}: {parsed.error}"
    return parsed.options


def review_error(*argv: str) -> str:
    """The error message from a `review` invocation that should have failed."""
    parsed = parse_args(["review", *argv])
    assert parsed.command == "review"
    return parsed.error or ""


# --- subcommand dispatch ---------------------------------------------------


def test_no_args_is_bad_usage_not_a_hook() -> None:
    """There is no hook behind bare `revgate` any more.

    A stale hooks.json that still invokes it must get a loud exit-2
    explanation, not a review UI.
    """
    parsed = parse_args([])
    assert parsed.command == "review"
    assert re.search(r"missing the `review` subcommand", parsed.error or "")


@pytest.mark.parametrize(
    "argv",
    [
        ["--plan"],
        ["--plan", "PLAN.md"],
        ["--no-open", "--no-history"],
        ["--history-dir", "/tmp/hist"],
    ],
)
def test_legacy_agent_stop_hook_shapes_are_bad_usage_now(argv: list[str]) -> None:
    """Every flag-only invocation was once a legitimate agentStop hook command line.

    None of them may open a review or pass silently any more.
    """
    parsed = parse_args(argv)
    assert parsed.command == "review", f"{' '.join(argv)} must not run as a hook"
    assert re.search(r"missing the `review` subcommand", parsed.error or ""), " ".join(argv)


def test_bare_help_is_a_usage_request_not_an_error() -> None:
    parsed = parse_args(["--help"])
    assert parsed.command == "review"
    assert parsed.error is None
    assert parsed.options.help is True

    short = parse_args(["-h"])
    assert short.error is None
    assert short.options.help is True


def test_review_selects_the_cli_command() -> None:
    assert parse_args(["review"]).command == "review"


@pytest.mark.parametrize(
    ("argv", "word"),
    [
        (["reviw"], "reviw"),
        (["reveiw", "--exit-code-on-comments"], "reveiw"),
        (["HEAD~3"], "HEAD~3"),
        (["--no-open", "reviw"], "reviw"),
        (["--include", "src", "reveiw", "--exit-code-on-comments"], "reveiw"),
    ],
)
def test_a_mistyped_subcommand_is_bad_usage_with_the_word_named(argv: list[str], word: str) -> None:
    """A bare word is a mistyped CLI call, never a git ref of a review nobody asked for.

    The word is looked for among the *positionals*, not at argv[0], so a flag
    written before the typo (`revgate --no-open reviw`) is caught the same way.
    """
    parsed = parse_args(argv)
    assert parsed.command == "review", f"{' '.join(argv)} must not run as a hook"
    assert re.search(f"unknown command: {re.escape(word)}", parsed.error or "")


@pytest.mark.parametrize(
    "argv",
    [
        ["--exit-code-on-comments"],
        ["--staged"],
        ["-o", "out.md"],
        ["--output=out.md"],
        ["-I", "src"],
        ["--include", "src"],
        ["-X", "dist"],
        ["--exclude", "dist"],
        ["--no-open", "-o", "out.md", "--exit-code-on-comments"],
    ],
)
def test_a_review_flag_without_the_subcommand_is_bad_usage_too(argv: list[str]) -> None:
    """A dropped `review` must not silently change what the flags mean."""
    parsed = parse_args(argv)
    assert parsed.command == "review", f"{' '.join(argv)} must not run as a hook"
    assert re.search(r"missing the `review` subcommand", parsed.error or ""), " ".join(argv)


def test_the_same_command_line_with_review_in_front_parses() -> None:
    assert review("-o", "out.md", "--exit-code-on-comments").output == "out.md"


@pytest.mark.parametrize(
    "argv",
    [
        ["plan"],
        ["plan", "--totally-bogus"],
        ["plan", "a", "b", "c", "--include"],
    ],
)
def test_plan_hook_parses_before_any_flag_validation(argv: list[str]) -> None:
    """The plan gate is a hook: a usage error there would fail *closed*.

    So argv must never be rejected — not even a flag we have never heard of.
    """
    parsed = parse_args(argv)
    assert parsed.command == "plan"
    # Nothing a caller could accidentally turn into a non-zero exit.
    assert parsed.error is None


def test_plan_hook_still_honours_the_flags_it_understands() -> None:
    """The hook is one command line in hooks.json.

    The only way a user can opt out of history on the plan gate is a flag after
    the subcommand.
    """
    parsed = parse_args(["plan", "--no-history", "--no-open"])
    assert parsed.command == "plan"
    assert parsed.options.history is False
    assert parsed.options.open is False

    directory = parse_args(["plan", "--history-dir", "/tmp/hist"])
    assert directory.options.history_dir == "/tmp/hist"


def test_an_unknown_flag_without_a_subcommand_keeps_its_own_error() -> None:
    """The parse error is more specific than the missing-subcommand fallback.

    The first problem is the one that explains the rest.
    """
    parsed = parse_args(["--totally-bogus"])
    assert parsed.command == "review"
    assert re.search(r"unknown flag: --totally-bogus", parsed.error or "")


# --- ref forms -------------------------------------------------------------


def test_no_refs_means_the_working_tree() -> None:
    scope = review().scope
    assert scope.kind == "worktree"
    assert scope.refs == []
    assert scope.include == []
    assert scope.exclude == []


def test_a_single_ref() -> None:
    scope = review("HEAD~3").scope
    assert scope.kind == "ref"
    assert scope.refs == ["HEAD~3"]
    assert scope.dots is None


def test_two_refs_are_a_two_dot_range() -> None:
    scope = review("main", "feature").scope
    assert scope.kind == "range"
    assert scope.refs == ["main", "feature"]
    assert scope.dots == ".."


def test_a_dotted_two_dot_range() -> None:
    scope = review("main..feature").scope
    assert scope.kind == "range"
    assert scope.refs == ["main", "feature"]
    assert scope.dots == ".."


def test_a_dotted_three_dot_range() -> None:
    scope = review("main...feature").scope
    assert scope.kind == "range"
    assert scope.refs == ["main", "feature"]
    assert scope.dots == "..."


def test_an_omitted_range_side_defaults_to_head() -> None:
    assert review("main..").scope.refs == ["main", "HEAD"]
    assert review("..feature").scope.refs == ["HEAD", "feature"]
    assert review("main...").scope.refs == ["main", "HEAD"]
    assert review("...feature").scope.refs == ["HEAD", "feature"]


def test_a_ref_with_a_tilde_or_caret_is_not_mistaken_for_a_range() -> None:
    assert review("HEAD^").scope.kind == "ref"
    assert review("origin/main~10").scope.kind == "ref"


def test_a_third_positional_is_an_error() -> None:
    assert re.search(r"unexpected argument: c", review_error("a", "b", "c"))


# --- flags -----------------------------------------------------------------


def test_staged() -> None:
    scope = review("--staged").scope
    assert scope.kind == "staged"
    assert scope.refs == []


def test_staged_with_refs_is_an_error() -> None:
    assert re.search(r"--staged cannot be combined", review_error("--staged", "main..feature"))
    assert re.search(r"--staged cannot be combined", review_error("HEAD~1", "--staged"))


def test_include_repeats_and_accepts_both_spellings() -> None:
    assert review("--include", "src").scope.include == ["src"]
    assert review("--include=src").scope.include == ["src"]
    assert review("-I", "src").scope.include == ["src"]
    assert review("--include", "src", "-I", "test", "--include=docs").scope.include == [
        "src",
        "test",
        "docs",
    ]


def test_exclude_repeats_and_accepts_both_spellings() -> None:
    assert review("--exclude", "dist").scope.exclude == ["dist"]
    assert review("--exclude=dist").scope.exclude == ["dist"]
    assert review("-X", "dist", "-X", "node_modules").scope.exclude == ["dist", "node_modules"]


def test_include_and_exclude_compose_with_refs() -> None:
    scope = review("main..feature", "-I", "src", "-X", "src/generated").scope
    assert scope.kind == "range"
    assert scope.refs == ["main", "feature"]
    assert scope.include == ["src"]
    assert scope.exclude == ["src/generated"]


def test_a_value_flag_with_no_value_is_an_error() -> None:
    assert re.search(r"--include requires a value", review_error("--include"))
    assert re.search(r"--include requires a value", review_error("--include", "--staged"))
    assert re.search(r"--exclude requires a value", review_error("--exclude="))


def test_a_value_token_starting_with_a_dash_is_not_consumed() -> None:
    """`--include --staged` refuses the value and leaves `--staged` to be parsed."""
    parsed = parse_args(["review", "--include", "--staged"])
    assert re.search(r"--include requires a value", parsed.error or "")
    assert parsed.options.scope.kind == "staged", "--staged was swallowed as a value"


def test_no_open() -> None:
    assert review().open is True
    assert review("--no-open").open is False


def test_output_accepts_both_spellings_and_an_inline_value() -> None:
    assert review().output is None
    assert review("--output", "review.md").output == "review.md"
    assert review("--output=review.md").output == "review.md"
    assert review("-o", "review.md").output == "review.md"


@pytest.mark.parametrize(
    "flag", ["-I", "--include", "-X", "--exclude", "-o", "--output", "--history-dir"]
)
def test_an_empty_separate_token_value_is_an_error_too(flag: str) -> None:
    """The inline form already fails; a separate empty token must too.

    Otherwise the `if value` at the call site drops it in silence: `-o ""`
    leaves the annotations on stdout and `-I ""` reviews the whole tree.
    """
    assert re.search(f"{re.escape(flag)} requires a value", review_error(flag, "")), flag


def test_output_with_no_value_is_an_error() -> None:
    assert re.search(r"--output requires a value", review_error("--output"))
    assert re.search(r"--output requires a value", review_error("--output="))


def test_exit_code_on_comments() -> None:
    assert review().exit_code_on_comments is False
    assert review("--exit-code-on-comments").exit_code_on_comments is True


def test_no_history_opts_out_of_persistence() -> None:
    assert review().history is True
    assert review("--no-history").history is False
    # The plan hook gets the same default, so the gate saves its review too.
    assert parse_args(["plan"]).options.history is True


def test_history_dir_accepts_both_spellings() -> None:
    assert review().history_dir is None
    assert review("--history-dir", "reviews").history_dir == "reviews"
    assert review("--history-dir=reviews").history_dir == "reviews"


def test_history_dir_with_no_value_is_an_error() -> None:
    assert re.search(r"--history-dir requires a value", review_error("--history-dir"))
    assert re.search(r"--history-dir requires a value", review_error("--history-dir="))


@pytest.mark.parametrize(
    "flag", ["--no-history", "--staged", "--exit-code-on-comments", "--no-open", "--help"]
)
@pytest.mark.parametrize("value", ["false", "true", ""])
def test_a_boolean_switch_rejects_an_inline_value_instead_of_inverting_it(
    flag: str, value: str
) -> None:
    """`--no-history=false` reads as "keep history".

    Accepting it as bare `--no-history` inverts the caller's intent in silence,
    and the caller is an LLM with no way to notice.
    """
    assert re.search(f"{re.escape(flag)} does not take a value", review_error(f"{flag}={value}")), (
        f"{flag}={value}"
    )


def test_the_bare_spellings_of_those_switches_are_untouched() -> None:
    assert review("--no-history").history is False
    assert review("--exit-code-on-comments").exit_code_on_comments is True


def test_a_short_flag_does_not_split_an_inline_value() -> None:
    """`-o=x` falls through to the unknown-flag branch: only long flags take `=`."""
    assert re.search(r"unknown flag: -o=x", review_error("-o=x"))


def test_the_skills_full_invocation_parses_cleanly() -> None:
    options = review(
        "main..feature", "-I", "src", "-X", "dist", "--no-open", "--exit-code-on-comments"
    )
    assert options.scope.kind == "range"
    assert options.exit_code_on_comments is True
    assert options.open is False


def test_help() -> None:
    assert review("--help").help is True
    assert review("-h").help is True
    assert review().help is False


# --- --plan ----------------------------------------------------------------


def test_bare_plan_has_no_file() -> None:
    options = review("--plan")
    assert options.plan is True
    assert options.plan_file is None


def test_plan_with_a_path() -> None:
    options = review("--plan", "docs/plan.md")
    assert options.plan is True
    assert options.plan_file == "docs/plan.md"


def test_plan_with_an_inline_path() -> None:
    options = review("--plan=docs/plan.md")
    assert options.plan is True
    assert options.plan_file == "docs/plan.md"


def test_plan_followed_by_a_flag_keeps_the_path_empty() -> None:
    options = review("--plan", "--no-open")
    assert options.plan is True
    assert options.plan_file is None
    assert options.open is False


def test_plan_with_an_empty_inline_value_is_an_error() -> None:
    assert re.search(r"--plan= requires a path", review_error("--plan="))


def test_plan_with_an_empty_token_is_no_path_not_an_empty_path() -> None:
    """`--plan "$PLAN"` with $PLAN unset.

    Recording "" as the path would suppress the documented $REVGATE_PLAN_FILE
    fallback, since the resolver only falls back when no path was given at all.
    """
    options = review("--plan", "")
    assert options.plan is True
    assert options.plan_file is None
    # It is still consumed: leaving it behind makes it a positional, which the
    # subcommand check would reject as a mistyped command.
    assert options.open is True


# --- unknown flags ---------------------------------------------------------


def test_an_unknown_flag_is_an_error_on_the_review_path() -> None:
    assert re.search(r"unknown flag: --nope", review_error("--nope"))
    assert re.search(r"unknown flag: -Z", review_error("-Z"))


def test_a_lone_dash_is_a_positional_not_a_flag() -> None:
    assert re.search(r"unknown command: -", parse_args(["-"]).error or "")


def test_the_first_problem_is_the_one_reported() -> None:
    assert re.search(r"unknown flag: --nope", review_error("--nope", "--also-nope"))


def test_parsing_continues_after_the_first_error() -> None:
    """`review --bogus --help` still records the help flag, and still exits 2.

    This is why the grammar is hand-ported rather than expressed in Click,
    which stops at the first error.
    """
    parsed = parse_args(["review", "--bogus", "--help"])
    assert re.search(r"unknown flag: --bogus", parsed.error or "")
    assert parsed.options.help is True


@pytest.mark.parametrize(
    "argv",
    [
        ["--plan", "p.md", "--staged"],
        ["--plan", "p.md", "main..feature"],
        ["--plan", "p.md", "--include", "src"],
        ["--plan", "p.md", "--exclude", "src/generated"],
    ],
)
def test_plan_cannot_be_combined_with_a_diff_scope(argv: list[str]) -> None:
    """The review command discards the scope on the plan path.

    Accepting these would silently review something other than what was asked for.
    """
    assert re.search(r"--plan reviews a plan document", review_error(*argv)), (
        f"{' '.join(argv)} was accepted"
    )


def test_a_plan_review_with_its_own_flags_still_parses() -> None:
    assert review("--plan", "p.md", "--no-open", "--exit-code-on-comments").plan is True
