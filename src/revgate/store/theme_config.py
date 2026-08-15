"""The one place a theme choice is remembered.

The random port makes every run a new browser origin, so `~/.revgate/config.json`
is the only store that survives a session. Nothing here raises — see the theme
rule in agents.md.
"""

import contextlib
import json
import os
import threading
from dataclasses import dataclass, field
from pathlib import Path

from revgate.shared.log import warn
from revgate.store.palettes import BUILTIN_THEMES, SYSTEM_THEME_ID, Theme, is_known_theme_id

#: One lock per process: a per-call lock would serialize nothing. The picker
#: POSTs once per `change`, and unserialized writes race over the same file.
_WRITE_LOCK = threading.Lock()


@dataclass(slots=True)
class ThemeConfig:
    """The whole config file — one key, for now."""

    theme: str


@dataclass(slots=True)
class ThemeListing:
    """Every built-in palette plus the current selection."""

    #: The saved id, or `system` when it doesn't resolve to anything known.
    selected: str
    themes: list[Theme] = field(default_factory=list)


def config_dir() -> Path:
    """Where `config.json` lives: `$REVGATE_CONFIG_DIR`, else `~/.revgate`."""
    override = (os.environ.get("REVGATE_CONFIG_DIR") or "").strip()
    if override:
        # `.absolute()`, not `.resolve()`: a symlinked temp directory must come
        # back as the caller spelled it, with no link followed.
        return Path(override).absolute()
    return Path.home() / ".revgate"


def config_file() -> Path:
    """The config file itself — always `config.json` inside `config_dir()`."""
    return config_dir() / "config.json"


def read_theme_config() -> ThemeConfig:
    """The saved config, or `system`.

    A missing file is the normal first run and stays quiet.
    """
    file = config_file()
    try:
        raw = file.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ThemeConfig(theme=SYSTEM_THEME_ID)
    except OSError as err:
        warn(f"could not read {file}: {err}")
        return ThemeConfig(theme=SYSTEM_THEME_ID)

    try:
        parsed = json.loads(raw)
    except ValueError as err:
        warn(f"ignoring malformed {file}: {err}")
        return ThemeConfig(theme=SYSTEM_THEME_ID)
    if not isinstance(parsed, dict):
        warn(f"ignoring malformed {file}: expected a JSON object")
        return ThemeConfig(theme=SYSTEM_THEME_ID)
    theme = parsed.get("theme")
    return ThemeConfig(theme=theme if isinstance(theme, str) else SYSTEM_THEME_ID)


def write_theme_config(theme_id: str) -> bool:
    """Save the chosen theme, returning whether it landed on disk.

    Serialized through the module lock, because the picker POSTs once per
    `change` and unserialized writes race.
    """
    with _WRITE_LOCK:
        return _save_theme_config(theme_id)


def _save_theme_config(theme_id: str) -> bool:
    file = config_file()
    directory = file.parent
    # Beside the target, so the rename is atomic; the pid separates two servers.
    temp = directory / f".config.json.{os.getpid()}.tmp"
    try:
        directory.mkdir(parents=True, exist_ok=True)
        payload = json.dumps({"theme": theme_id}, indent=2) + "\n"
        temp.write_text(payload, encoding="utf-8", newline="")
        temp.replace(file)
    except OSError as err:
        # The rename publishes the file, so a failure after the write leaves litter.
        # Nothing more to do if the cleanup fails too: the warning is the report.
        with contextlib.suppress(OSError):
            temp.unlink(missing_ok=True)
        warn(f"could not save theme to {file}: {err}")
        return False
    return True


def list_themes() -> ThemeListing:
    """Every palette plus the selection, so switching needs no further round trip.

    An unknown id falls back to `system` rather than leaving the page unstyled.
    """
    theme = read_theme_config().theme
    return ThemeListing(
        selected=theme if is_known_theme_id(theme) else SYSTEM_THEME_ID, themes=BUILTIN_THEMES
    )
