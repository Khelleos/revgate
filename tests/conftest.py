"""Suite-wide isolation.

`~/.revgate` and `~/.copilot` are redirected by an autouse fixture rather than
by each test, so a new test cannot forget, and so cannot write a review, a
theme, or a history entry into the real home directory.
"""

from pathlib import Path

import pytest

from tests.helpers.repo import make_repo  # noqa: F401 — re-exported as a suite-wide fixture


@pytest.fixture(autouse=True)
def isolate_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Point every `~/.revgate` and `~/.copilot` path at a per-test directory."""
    home = tmp_path / "home"
    monkeypatch.setenv("REVGATE_HISTORY_DIR", str(home / "revgate" / "history"))
    monkeypatch.setenv("REVGATE_CONFIG_DIR", str(home / "revgate"))
    monkeypatch.setenv("COPILOT_HOME", str(home / "copilot"))
    # Not set to a temporary path: its absence is what the `--plan` fallback
    # tests assert against, and a stray value in the developer's shell would
    # otherwise leak into them.
    monkeypatch.delenv("REVGATE_PLAN_FILE", raising=False)
