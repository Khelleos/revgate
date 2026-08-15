"""The agent's `preToolUse` plan gate.

Fail-open throughout: a non-zero exit reads as a denial, so every error path
ends in an explicit `allow` at exit 0. `gate_plan` is shared with
`revgate review --plan`, so it returns a decision.
"""

import contextlib
import json
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Any

from revgate.cli.grammar import CliOptions
from revgate.integrations.copilot import find_copilot_plan_content
from revgate.review.feedback import build_decision
from revgate.review.plan import plan_title, plan_to_files
from revgate.review.report import ReviewOutcomeSummary
from revgate.server.app import ReviewContext, start_review_server
from revgate.server.browser import open_browser
from revgate.server.wsgi import ServerClosed
from revgate.shared.jsonio import dumps_compact
from revgate.shared.log import log, warn
from revgate.shared.streams import write_stdout
from revgate.shared.types import HookDecision, HookPayload, PermissionDecision
from revgate.store.history import HistoryMeta, save_history


@dataclass(slots=True)
class ReviewOutcome:
    """One review's output: the report summary plus what only the hook paths need."""

    summary: ReviewOutcomeSummary
    #: The hook verdict, set only by the plan path.
    decision: HookDecision | None = None


def emit_permission(decision: PermissionDecision) -> None:
    """Emit a `preToolUse` permission decision (the plan hook's output contract)."""
    write_stdout(dumps_compact(decision) + "\n")


def _parse_tool_args(value: Any) -> dict[str, Any] | None:
    """Tool args reach us as a nested object or a JSON string; normalize to a dict."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except ValueError:
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


#: How long to wait for the hook payload before giving up on it.
#:
#: A parent that writes the payload but never closes the pipe would otherwise
#: keep this process alive until Copilot's own hook timeout — the agent's turn
#: stalls, and the gate never opens.
READ_TIMEOUT = 2.0


def _read_with_timeout(stream: IO[str]) -> str:
    """Read a stream to EOF, or give up after `READ_TIMEOUT`."""
    received: list[str] = []

    def pump() -> None:
        # An unreadable pipe is simply "no payload", the same as an empty one.
        with contextlib.suppress(OSError, ValueError):
            received.append(stream.read())

    reader = threading.Thread(target=pump, daemon=True)
    reader.start()
    reader.join(READ_TIMEOUT)
    return received[0] if received else ""


def read_hook_payload(stdin: IO[str] | None = None) -> HookPayload | None:
    """Read the hook payload from stdin, normalizing both known formats."""
    stream = stdin if stdin is not None else sys.stdin
    # An interactive TTY means there is no piped payload (e.g. a manual run).
    try:
        if stream.isatty():
            return None
    except AttributeError, ValueError:
        pass

    raw = _read_with_timeout(stream)

    # Strip a leading UTF-8 BOM — some shells and pipes prepend one.
    clean = raw.lstrip("﻿").strip()
    if not clean:
        return None
    try:
        parsed = json.loads(clean)
    except ValueError as err:
        warn(f"could not parse hook payload: {err}")
        return None
    if not isinstance(parsed, dict):
        warn("could not parse hook payload: expected a JSON object")
        return None

    # The shape the CLI emits: `toolCalls` of { id, name, args }, args a JSON
    # string, the plan in the plan tool's own `plan`/`summary`. Taking `summary`
    # off whatever came first would review an unrelated tool's arguments.
    tool_name = parsed.get("toolName") or parsed.get("tool_name")
    inline_plan = None
    tool_calls = parsed.get("toolCalls")
    if isinstance(tool_calls, list) and tool_calls:
        plan_call = next(
            (t for t in tool_calls if isinstance(t, dict) and t.get("name") == "exit_plan_mode"),
            None,
        )
        chosen = plan_call if plan_call is not None else tool_calls[0]
        if isinstance(chosen, dict) and chosen.get("name") is not None:
            tool_name = chosen.get("name")
        args = _parse_tool_args(plan_call.get("args") if plan_call is not None else None)
        if args is not None:
            inline_plan = args.get("plan") if args.get("plan") is not None else args.get("summary")

    # Other shapes (postToolUse, VS Code, manual): the plan sits top-level or in
    # tool_input, which may itself be a JSON string.
    raw_input = next(
        (
            parsed[key]
            for key in ("toolArgs", "tool_input", "toolInput", "input")
            if parsed.get(key) is not None
        ),
        None,
    )
    tool_input = _parse_tool_args(raw_input)
    plan = parsed.get("plan")
    if plan is None:
        plan = inline_plan
    if plan is None and tool_input is not None:
        plan = tool_input.get("plan")

    # Accept camelCase or VS Code snake_case field names.
    session_id = parsed.get("sessionId")
    if session_id is None:
        session_id = parsed.get("session_id")
    timestamp = parsed.get("timestamp")
    cwd = parsed.get("cwd")
    return HookPayload(
        session_id=str(session_id if session_id is not None else ""),
        timestamp=timestamp if isinstance(timestamp, int | str) else int(time.time() * 1000),
        cwd=str(cwd) if cwd is not None else str(_cwd()),
        tool_name=tool_name if isinstance(tool_name, str) else None,
        plan=plan if isinstance(plan, str) else None,
    )


def _cwd() -> str:
    return str(Path.cwd())


def gate_plan(payload: HookPayload, plan_text: str, options: CliOptions) -> ReviewOutcome:
    """Open the plan review page: approve -> allow, request-changes -> block. Never raises."""
    files = plan_to_files(plan_text)
    title = plan_title(plan_text)
    ctx = ReviewContext(
        payload=payload,
        branch=None,
        files=files,
        is_repo=False,
        mode="plan",
        plan_title=title,
    )

    log(f"session {payload.session_id} — reviewing proposed plan")
    server = start_review_server(ctx)
    log(f"plan review page at {server.url}{' — opening browser…' if options.open else ''}")
    if options.open:
        open_browser(server.url)

    try:
        # ONLY this one statement is fail-open, and it catches only ServerClosed:
        # catching Exception here would turn a request_changes into an approval.
        try:
            review = server.gate.wait()
        except ServerClosed as err:
            note = f"No plan review was captured ({err})."
            warn(f"{note} Allowing.")
            return ReviewOutcome(
                summary=ReviewOutcomeSummary(review=None, files=files, note=note, interrupted=True),
                decision=HookDecision(decision="allow"),
            )

        decision = build_decision(review, files)
        save_history(
            review,
            files,
            HistoryMeta(
                cwd=payload.cwd or _cwd(),
                session_id=payload.session_id,
                scope=f"plan: {title}" if title else "plan",
                mode="plan",
                enabled=options.history,
                history_dir=options.history_dir,
            ),
        )
        # Neutral wording: this path is shared with `revgate review --plan`,
        # which hands nothing to any agent.
        log("plan changes requested" if decision.decision == "block" else "plan approved")
        return ReviewOutcome(
            summary=ReviewOutcomeSummary(review=review, files=files), decision=decision
        )
    finally:
        server.close()


def run_plan_hook(options: CliOptions) -> None:
    """The `revgate plan` entry.

    The hook fires before EVERY tool and carries no matcher, so anything not
    positively `exit_plan_mode` passes through: better to miss a gate than to
    gate an unrelated tool.
    """
    payload = read_hook_payload()
    if payload is None:
        payload = HookPayload(session_id="", timestamp=int(time.time() * 1000), cwd=_cwd())

    if payload.tool_name != "exit_plan_mode":
        if not payload.tool_name:
            warn("preToolUse payload had no identifiable tool — allowing")
        emit_permission({"permissionDecision": "allow"})
        return

    # Prefer the full plan Copilot wrote for THIS session, else the condensed one
    # in the tool arguments. With no session id the cross-session scan could
    # return another repository's plan, so there the inline plan wins.
    inline_plan = payload.plan if payload.plan and payload.plan.strip() else None
    if payload.session_id:
        plan_text = find_copilot_plan_content(payload.session_id) or inline_plan
    else:
        plan_text = inline_plan or find_copilot_plan_content()

    if not plan_text or not plan_text.strip():
        log("no plan text found for plan hook — allowing the tool to proceed")
        emit_permission({"permissionDecision": "allow"})
        return

    outcome = gate_plan(payload, plan_text, options)
    decision = outcome.decision
    if decision is not None and decision.decision == "block":
        emit_permission(
            {
                "permissionDecision": "deny",
                "permissionDecisionReason": decision.reason
                or "The reviewer requested changes to the plan.",
            }
        )
    else:
        emit_permission({"permissionDecision": "allow"})
