"""Locating the plan text for a Copilot plan-mode turn.

Copilot writes it to `plan.md` under `~/.copilot/session-state/<sessionId>/`
rather than passing it through the tool arguments, so the hook reads it off disk.
"""

import os
import re
from pathlib import Path

#: The shape a Copilot session id takes. It contains neither a dot nor a path
#: separator, which is exactly why an id that passes cannot traverse.
_SESSION_ID_RE = re.compile(r"^[a-f0-9-]{36}$", re.IGNORECASE)


def _copilot_home() -> Path:
    return Path(os.environ.get("COPILOT_HOME") or (Path.home() / ".copilot"))


def find_copilot_plan_content(  # noqa: PLR0911 — each return is a distinct "no plan" case
    session_id: str | None = None,
) -> str | None:
    """The plan text for this turn, or None."""
    sessions_dir = _copilot_home() / "session-state"
    if not sessions_dir.is_dir():
        return None

    # With a session id, trust ONLY that session's plan.md: another session's is
    # the wrong plan for this turn. The id check keeps a payload out of the path.
    if session_id:
        if _SESSION_ID_RE.match(session_id):
            plan_path = sessions_dir / session_id / "plan.md"
            try:
                text = plan_path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                return None
            # An empty plan.md is "no plan": "" would beat the caller's fallback.
            if text.strip():
                return text
        return None

    # Only when the hook gave us no session id: the newest plan.md anywhere.
    candidates: list[tuple[float, Path]] = []
    try:
        entries = list(sessions_dir.iterdir())
    except OSError:
        return None
    for entry in entries:
        if not entry.is_dir():
            continue
        plan_path = entry / "plan.md"
        try:
            candidates.append((plan_path.stat().st_mtime, plan_path))
        except OSError:
            continue

    if not candidates:
        return None
    candidates.sort(key=lambda pair: pair[0], reverse=True)
    try:
        text = candidates[0][1].read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    return text if text.strip() else None
