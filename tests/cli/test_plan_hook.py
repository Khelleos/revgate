"""The two halves of the plan gate that are worth exercising in-process.

`test_main.py` owns the contract-level cases — exit codes and what reaches
stdout can only be observed on a real process — but the payload shapes and the
verdict translation are plain functions.
"""

import io
import json
import re
import sys
import threading
from pathlib import Path
from typing import Any

import pytest

from revgate.cli.grammar import CliOptions
from revgate.cli.plan_hook import ReviewOutcome, gate_plan, read_hook_payload
from revgate.shared.types import HookPayload
from tests.helpers.server import post


class _Tty(io.StringIO):
    """A stream that claims to be interactive, the way a manual run's stdin is."""

    def isatty(self) -> bool:
        return True


def stdin(text: str) -> io.StringIO:
    """A payload stream the way Copilot pipes one."""
    return io.StringIO(text)


def options(**overrides: Any) -> CliOptions:
    fields: dict[str, Any] = {
        "open": False,
        "plan": True,
        # Off by default: a unit test must never write to anyone's history tree.
        "history": False,
    }
    fields.update(overrides)
    return CliOptions(**fields)


def payload(**overrides: Any) -> HookPayload:
    fields: dict[str, Any] = {"session_id": "unit", "timestamp": 0, "cwd": str(Path.cwd())}
    fields.update(overrides)
    return HookPayload(**fields)


# --- read_hook_payload -----------------------------------------------------


def test_it_reads_copilots_tool_calls_shape_with_args_as_a_json_string() -> None:
    parsed = read_hook_payload(
        stdin(
            json.dumps(
                {
                    "sessionId": "abc",
                    "toolCalls": [
                        {
                            "id": "1",
                            "name": "exit_plan_mode",
                            "args": json.dumps({"plan": "# Plan: ship it\n"}),
                        }
                    ],
                }
            )
        )
    )
    assert parsed is not None
    assert parsed.tool_name == "exit_plan_mode"
    assert parsed.plan == "# Plan: ship it\n"
    assert parsed.session_id == "abc"


def test_args_given_as_an_object_are_accepted_too() -> None:
    parsed = read_hook_payload(
        stdin(
            json.dumps(
                {
                    "sessionId": "abc",
                    "toolCalls": [
                        {"id": "1", "name": "exit_plan_mode", "args": {"summary": "# Plan\n"}}
                    ],
                }
            )
        )
    )
    assert parsed is not None
    assert parsed.tool_name == "exit_plan_mode"
    assert parsed.plan == "# Plan\n"


def test_the_plan_tool_is_found_past_an_unrelated_first_tool_call() -> None:
    """The gate self-filters on `tool_name`.

    Picking toolCalls[0] blindly would let a real plan through unreviewed
    whenever it is not the first call.
    """
    parsed = read_hook_payload(
        stdin(
            json.dumps(
                {
                    "toolCalls": [
                        {"id": "1", "name": "shell", "args": json.dumps({"summary": "not a plan"})},
                        {
                            "id": "2",
                            "name": "exit_plan_mode",
                            "args": json.dumps({"plan": "# Plan: real\n"}),
                        },
                    ]
                }
            )
        )
    )
    assert parsed is not None
    assert parsed.tool_name == "exit_plan_mode"
    assert parsed.plan == "# Plan: real\n"


def test_a_non_plan_tools_summary_is_never_harvested_as_a_plan() -> None:
    """`summary` is a common argument name.

    Taking it from an unrelated tool would open a plan review over someone
    else's arguments.
    """
    parsed = read_hook_payload(
        stdin(
            json.dumps(
                {
                    "toolCalls": [
                        {
                            "id": "1",
                            "name": "write_file",
                            "args": json.dumps({"summary": "# Nope\n"}),
                        }
                    ]
                }
            )
        )
    )
    assert parsed is not None
    assert parsed.tool_name == "write_file"
    assert parsed.plan is None


def test_vs_codes_snake_case_shape_is_understood() -> None:
    parsed = read_hook_payload(
        stdin(
            json.dumps(
                {
                    "session_id": "abc",
                    "tool_name": "exit_plan_mode",
                    "tool_input": {"plan": "# Plan: vs code\n"},
                }
            )
        )
    )
    assert parsed is not None
    assert parsed.session_id == "abc"
    assert parsed.tool_name == "exit_plan_mode"
    assert parsed.plan == "# Plan: vs code\n"


def test_a_tool_input_that_is_itself_a_json_string_is_parsed() -> None:
    parsed = read_hook_payload(
        stdin(
            json.dumps(
                {
                    "tool_name": "exit_plan_mode",
                    "tool_input": json.dumps({"plan": "# Plan: nested\n"}),
                }
            )
        )
    )
    assert parsed is not None
    assert parsed.plan == "# Plan: nested\n"


def test_a_leading_utf8_bom_is_stripped() -> None:
    """A BOM makes the parse fail, and with it the tool name is lost.

    That turns a real plan into a pass-through.
    """
    parsed = read_hook_payload(
        stdin("﻿" + json.dumps({"sessionId": "bom", "toolName": "exit_plan_mode"}))
    )
    assert parsed is not None
    assert parsed.session_id == "bom"
    assert parsed.tool_name == "exit_plan_mode"


@pytest.mark.parametrize("raw", ["", "   \n", "not json at all", "[]", '"a string"'])
def test_an_empty_or_unparseable_payload_is_none_never_a_raise(raw: str) -> None:
    """The caller substitutes an empty payload and allows.

    A raise here would reach `main()`'s last-resort handler instead.
    """
    assert read_hook_payload(stdin(raw)) is None


def test_an_interactive_tty_has_no_piped_payload() -> None:
    assert read_hook_payload(_Tty(json.dumps({"toolName": "exit_plan_mode"}))) is None


def test_missing_fields_fall_back_rather_than_failing() -> None:
    parsed = read_hook_payload(stdin(json.dumps({})))
    assert parsed is not None
    assert parsed.session_id == ""
    assert parsed.cwd == str(Path.cwd())
    assert parsed.tool_name is None
    assert parsed.plan is None


# --- gate_plan -------------------------------------------------------------


def run_gate(plan_text: str, body: dict[str, Any]) -> ReviewOutcome:
    """Drive one plan review to a submission and return its outcome.

    `gate_plan` never returns its handle — the URL only ever reaches a human, on
    stderr — so the submission is driven from a second thread, which polls the
    stderr capture for the URL the server logged.
    """
    captured: list[ReviewOutcome] = []
    url_seen = threading.Event()
    url_box: list[str] = []
    buffer = io.StringIO()
    original = sys.stderr
    sys.stderr = buffer

    def watch() -> None:
        # A deadline, so a server that never logs its URL fails rather than hangs.
        for _ in range(2000):
            match = re.search(r"http://127\.0\.0\.1:\d+/", buffer.getvalue())
            if match:
                url_box.append(match.group(0))
                url_seen.set()
                return
            threading.Event().wait(0.01)
        url_seen.set()

    def submit() -> None:
        if not url_seen.wait(30) or not url_box:
            return
        post(f"{url_box[0]}api/submit", json.dumps(body))

    watcher = threading.Thread(target=watch, daemon=True)
    submitter = threading.Thread(target=submit, daemon=True)
    watcher.start()
    submitter.start()
    try:
        captured.append(gate_plan(payload(), plan_text, options()))
    finally:
        sys.stderr = original
        submitter.join(timeout=5)
    assert url_box, f"no review URL on stderr; captured:\n{buffer.getvalue()}"
    return captured[0]


def test_an_approval_becomes_an_allow_decision() -> None:
    outcome = run_gate(
        "# Plan: ship it\n\nStep one.\n",
        {"decision": "approve", "summary": "", "comments": []},
    )
    assert outcome.decision is not None
    assert outcome.decision.decision == "allow"
    assert outcome.decision.reason is None
    # The plan is reviewed as one synthetic file, which is what lets the whole
    # diff pipeline run over it unchanged.
    assert len(outcome.summary.files) == 1
    assert outcome.summary.files[0].path == "Plan"
    assert outcome.summary.interrupted is False


def test_request_changes_blocks_and_carries_the_feedback_back() -> None:
    outcome = run_gate(
        "# Plan: ship it\n\nStep one.\n",
        {
            "decision": "request_changes",
            "summary": "Add a rollback step.",
            "comments": [
                {"file": "Plan", "startLine": 3, "endLine": 3, "side": "new", "body": "Say how."}
            ],
        },
    )
    assert outcome.decision is not None
    assert outcome.decision.decision == "block"
    reason = outcome.decision.reason or ""
    assert "Add a rollback step." in reason
    assert re.search(r"Plan:3 \(\+\)", reason)
    assert "Say how." in reason
    assert outcome.summary.review is not None
    assert outcome.summary.review.decision == "request_changes"
