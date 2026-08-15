"""The `--help` output is a byte-exact constant."""

import re

import pytest

from revgate.cli.help import help_text


@pytest.mark.parametrize(
    "token",
    [
        "revgate review",
        "revgate plan",
        "--staged",
        "--include",
        "-I",
        "--exclude",
        "-X",
        "--plan",
        "--output",
        "-o",
        "--exit-code-on-comments",
        "--history-dir",
        "--no-history",
        "--no-open",
        "--help",
        "-h",
    ],
)
def test_it_lists_every_flag_and_command(token: str) -> None:
    assert token in help_text(), f"help text is missing {token}"


def test_it_ends_with_exactly_one_newline() -> None:
    help_output = help_text()
    assert help_output.endswith("\n")
    assert not help_output.endswith("\n\n")


@pytest.mark.parametrize("pattern", [r"^ {2}0 {3}", r"^ {2}1 {3}", r"^ {2}2 {3}", r"^ {2}10 {2}"])
def test_it_documents_the_exit_codes_including_10(pattern: str) -> None:
    assert re.search(pattern, help_text(), re.MULTILINE)


def test_it_carries_no_carriage_returns() -> None:
    """stdout is a byte contract, and the help text is the largest thing on it."""
    assert "\r" not in help_text()
