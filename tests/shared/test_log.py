"""The log prefixes are a byte contract: stdout must stay empty, stderr must carry the line."""

import io
import sys

import pytest

from revgate.shared.log import log, warn


def test_log_writes_the_prefixed_line_to_stderr(capsys: pytest.CaptureFixture[str]) -> None:
    log("hello")
    captured = capsys.readouterr()
    assert captured.err == "[revgate] hello\n"
    assert captured.out == ""


def test_warn_writes_the_warn_prefix_to_stderr(capsys: pytest.CaptureFixture[str]) -> None:
    warn("something is off")
    captured = capsys.readouterr()
    assert captured.err == "[revgate] WARN something is off\n"
    assert captured.out == ""


def test_arguments_are_stringified_and_joined_by_one_space(
    capsys: pytest.CaptureFixture[str],
) -> None:
    log("staged", 3, "files")
    warn("code", 7)
    captured = capsys.readouterr()
    assert captured.err == "[revgate] staged 3 files\n[revgate] WARN code 7\n"


def test_no_arguments_still_terminates_the_line(capsys: pytest.CaptureFixture[str]) -> None:
    log()
    assert capsys.readouterr().err == "[revgate] \n"


def test_the_stream_is_resolved_at_call_time(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A module-level `from sys import stderr` would write to the original stream.

    Every test in this suite that asserts on stderr depends on the late lookup,
    and so does the review command, which runs under a redirected stream.
    """
    replacement = io.StringIO()
    monkeypatch.setattr(sys, "stderr", replacement)
    log("redirected")
    assert replacement.getvalue() == "[revgate] redirected\n"
    assert capsys.readouterr().err == ""
