"""Finding the plan text a Copilot plan-mode turn is about."""

import os
import re
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

import pytest

from revgate.integrations.copilot import find_copilot_plan_content

SESSION_A = "11111111-2222-3333-4444-555555555555"
SESSION_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


class CopilotHome(Protocol):
    """Callable returned by the `copilot_home` fixture."""

    def __call__(self, plans: Mapping[str, str | None] | None = None) -> Path: ...


@pytest.fixture
def copilot_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> CopilotHome:
    """A factory for a fake `~/.copilot` tree, pointed at by `$COPILOT_HOME`.

    A `None` plan means "the session directory exists but holds no plan.md".
    """

    def build(plans: Mapping[str, str | None] | None = None) -> Path:
        home = tmp_path / "copilot"
        for session, content in (plans or {}).items():
            directory = home / "session-state" / session
            directory.mkdir(parents=True, exist_ok=True)
            if content is not None:
                (directory / "plan.md").write_text(content, encoding="utf-8", newline="")
        monkeypatch.setenv("COPILOT_HOME", str(home))
        return home

    return build


def touch(home: Path, session: str, when: str) -> None:
    """Force a plan.md's mtime so "newest wins" is deterministic."""
    stamp = datetime.fromisoformat(when).replace(tzinfo=UTC).timestamp()
    os.utime(home / "session-state" / session / "plan.md", (stamp, stamp))


# --- no state to read ------------------------------------------------------


def test_no_session_state_directory_at_all(copilot_home: CopilotHome) -> None:
    copilot_home()
    assert find_copilot_plan_content(SESSION_A) is None
    assert find_copilot_plan_content() is None


def test_session_state_exists_but_holds_no_plans(copilot_home: CopilotHome) -> None:
    copilot_home({SESSION_A: None, SESSION_B: None})
    assert find_copilot_plan_content() is None
    assert find_copilot_plan_content(SESSION_A) is None


# --- keyed on the session that fired the hook ------------------------------


def test_it_reads_this_sessions_plan(copilot_home: CopilotHome) -> None:
    copilot_home({SESSION_A: "# Plan A\n", SESSION_B: "# Plan B\n"})
    assert find_copilot_plan_content(SESSION_A) == "# Plan A\n"
    assert find_copilot_plan_content(SESSION_B) == "# Plan B\n"


def test_a_known_session_with_no_plan_never_borrows_anothers(copilot_home: CopilotHome) -> None:
    """Reviewing another session's plan would gate the wrong turn — None is correct."""
    copilot_home({SESSION_A: None, SESSION_B: "# Plan B\n"})
    assert find_copilot_plan_content(SESSION_A) is None


@pytest.mark.parametrize("session_id", ["manual", "cli", "latest", "..", "../..", "not-a-uuid"])
def test_a_session_id_that_is_not_a_uuid_is_rejected(
    session_id: str, copilot_home: CopilotHome
) -> None:
    copilot_home({SESSION_A: "# Plan A\n"})
    assert find_copilot_plan_content(session_id) is None, f"expected None for {session_id}"


def test_nothing_the_id_filter_accepts_can_escape_the_sessions_dir(
    copilot_home: CopilotHome,
) -> None:
    """The real guarantee is structural, not a list of rejected strings.

    Every id the filter lets through must resolve to a direct child of the
    sessions directory. The accepted set below is the extremes of what
    `^[a-f0-9-]{36}$` allows — note it holds no dot and no separator, which is
    exactly why none of them can traverse.
    """
    home = copilot_home({SESSION_A: "# Plan A\n"})
    # A plan.md one level up: if a session id could ever climb out, this is what
    # it would reach — the wrong session's plan, gating the wrong turn.
    (home / "plan.md").write_text("# Outside\n", encoding="utf-8")
    assert find_copilot_plan_content("../" * 12) is None

    sessions = home / "session-state"
    accepted = [
        SESSION_A,
        "a" * 36,
        "-" * 36,
        "0f0f0f0f-0f0f-0f0f-0f0f-0f0f0f0f0f0f",
        "-0-0-0-0-0-0-0-0-0-0-0-0-0-0-0-0-0-0",
    ]
    for session_id in accepted:
        assert re.match(r"^[a-f0-9-]{36}$", session_id, re.IGNORECASE), (
            f"{session_id} is not what the filter accepts"
        )
        relative = (sessions / session_id / "plan.md").relative_to(sessions)
        assert relative.parts[0] == session_id, f"{session_id} did not resolve to a direct child"
        assert ".." not in relative.parts, f"{session_id} escaped the sessions dir"


# --- fallback: newest plan across sessions ---------------------------------


def test_with_no_session_id_the_newest_plan_wins(copilot_home: CopilotHome) -> None:
    home = copilot_home({SESSION_A: "# Older\n", SESSION_B: "# Newer\n"})
    touch(home, SESSION_A, "2026-07-01T00:00:00")
    touch(home, SESSION_B, "2026-07-29T00:00:00")
    assert find_copilot_plan_content() == "# Newer\n"

    # Flip the order: the answer follows the mtime, not the directory listing.
    touch(home, SESSION_A, "2026-07-30T00:00:00")
    assert find_copilot_plan_content() == "# Older\n"


def test_sessions_without_a_plan_are_skipped_not_fatal(copilot_home: CopilotHome) -> None:
    home = copilot_home({SESSION_A: None, SESSION_B: "# Only one\n"})
    # A stray file next to the session directories must not be mistaken for one.
    (home / "session-state" / "loose.txt").write_text("noise\n", encoding="utf-8")
    assert find_copilot_plan_content() == "# Only one\n"


def test_an_empty_session_id_falls_back_like_none_at_all(copilot_home: CopilotHome) -> None:
    copilot_home({SESSION_A: "# Plan A\n"})
    assert find_copilot_plan_content("") == "# Plan A\n"


# --- an empty plan.md is "no plan" -----------------------------------------


def test_an_empty_plan_is_no_plan_not_a_plan(copilot_home: CopilotHome) -> None:
    """Returning "" would beat the inline plan in the hook's fallback.

    A truncated plan.md would then skip the gate, with usable plan text carried
    in the very tool call being gated.
    """
    copilot_home({SESSION_A: "", SESSION_B: "   \n\t\n"})
    assert find_copilot_plan_content(SESSION_A) is None
    assert find_copilot_plan_content(SESSION_B) is None


def test_the_no_session_fallback_treats_an_empty_newest_plan_as_none(
    copilot_home: CopilotHome,
) -> None:
    home = copilot_home({SESSION_A: "# Older\n", SESSION_B: ""})
    touch(home, SESSION_A, "2026-07-01T00:00:00")
    touch(home, SESSION_B, "2026-07-29T00:00:00")
    assert find_copilot_plan_content() is None
