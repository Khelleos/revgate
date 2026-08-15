"""The stdout discipline. These assertions are about bytes, not strings."""

import io
import sys

import pytest

from revgate.shared.streams import configure_stdio, flush_stdio, write_stdout


def test_configure_stdio_pins_utf8_and_stops_newline_translation() -> None:
    """The whole point: no CRLF, no cp1252.

    Run against a real `TextIOWrapper` over a byte buffer rather than the
    process streams, so the assertion is on the bytes that would reach a pipe.
    """
    buffer = io.BytesIO()
    stream = io.TextIOWrapper(buffer, encoding="cp1252", newline="\r\n")
    original = sys.stdout
    try:
        sys.stdout = stream
        configure_stdio()
        assert stream.encoding.lower().replace("-", "") == "utf8"
        write_stdout("a — é\n")
        stream.flush()
    finally:
        sys.stdout = original
    assert buffer.getvalue() == "a — é\n".encode()
    assert b"\r\n" not in buffer.getvalue(), "newline translation is still on"


def test_configure_stdio_replaces_an_unencodable_character_instead_of_raising() -> None:
    """A `UnicodeEncodeError` on the hook path exits non-zero and fails closed."""
    buffer = io.BytesIO()
    stream = io.TextIOWrapper(buffer, encoding="ascii", newline="")
    original = sys.stdout
    try:
        sys.stdout = stream
        configure_stdio()
        # A lone surrogate has no UTF-8 encoding. On the *encode* side the
        # `replace` handler substitutes `?` (U+003F) — U+FFFD is what the
        # *decode* side substitutes. Either way it is not an exception.
        write_stdout("ok \udce9\n")
        stream.flush()
    finally:
        sys.stdout = original
    assert buffer.getvalue() == b"ok ?\n"


def test_configure_stdio_is_a_no_op_on_a_stream_without_reconfigure() -> None:
    """pytest's capture object is not a `TextIOWrapper`; this must not raise."""
    original = sys.stdout
    try:
        sys.stdout = io.StringIO()
        configure_stdio()
    finally:
        sys.stdout = original


def test_write_stdout_resolves_the_stream_at_call_time(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    replacement = io.StringIO()
    monkeypatch.setattr(sys, "stdout", replacement)
    write_stdout("payload")
    assert replacement.getvalue() == "payload"


def test_flush_stdio_flushes_both_streams(monkeypatch: pytest.MonkeyPatch) -> None:
    flushed: list[str] = []

    class Recorder(io.StringIO):
        def __init__(self, name: str) -> None:
            super().__init__()
            self._name = name

        def flush(self) -> None:
            flushed.append(self._name)

    monkeypatch.setattr(sys, "stdout", Recorder("out"))
    monkeypatch.setattr(sys, "stderr", Recorder("err"))
    flush_stdio()
    assert flushed == ["out", "err"]
