"""Persisting a theme choice. Nothing here may raise: a failed write is a warning."""

import concurrent.futures
import json
from pathlib import Path

import pytest

from revgate.store.palettes import BUILTIN_THEMES
from revgate.store.theme_config import (
    config_dir,
    config_file,
    list_themes,
    read_theme_config,
    write_theme_config,
)


@pytest.fixture
def config_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A throwaway `$REVGATE_CONFIG_DIR` for one test."""
    directory = tmp_path / "cfg"
    directory.mkdir()
    monkeypatch.setenv("REVGATE_CONFIG_DIR", str(directory))
    return directory


# --- directory resolution --------------------------------------------------


def test_the_env_var_beats_home_and_names_the_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("REVGATE_CONFIG_DIR", raising=False)
    assert config_dir() == Path.home() / ".revgate"
    assert config_file() == Path.home() / ".revgate" / "config.json"

    monkeypatch.setenv("REVGATE_CONFIG_DIR", "   ")
    assert config_dir() == Path.home() / ".revgate"

    custom = tmp_path / "from-env"
    monkeypatch.setenv("REVGATE_CONFIG_DIR", str(custom))
    assert config_dir() == custom
    # The file name is never the caller's to choose.
    assert config_file() == custom / "config.json"


def test_a_relative_override_resolves_against_the_working_directory(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("REVGATE_CONFIG_DIR", "cfg")
    assert config_dir() == Path("cfg").absolute()
    assert config_dir().is_absolute()


# --- config persistence ----------------------------------------------------


def test_what_write_saves_read_returns(config_home: Path) -> None:
    assert write_theme_config("dracula") is True
    assert read_theme_config().theme == "dracula"
    on_disk = json.loads((config_home / "config.json").read_text(encoding="utf-8"))
    assert on_disk == {"theme": "dracula"}


def test_write_creates_the_config_directory_when_it_does_not_exist(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("REVGATE_CONFIG_DIR", str(tmp_path / "nested" / "deeper"))
    assert write_theme_config("monokai") is True
    assert read_theme_config().theme == "monokai"


def test_overlapping_writes_serialize(config_home: Path) -> None:
    """The picker POSTs once per `change`, and a focused select fires one per keypress.

    Unserialized these share one temp path: a rename can land between another
    call's write and its own rename, so one fails and the id left on disk is
    whichever won the race.

    `threading.Lock` is not FIFO, so *which* pick wins is not observable and is
    not asserted. The real invariant is: every call reports success, exactly one
    file survives, and it holds one of the picks intact.
    """
    picks = ["monokai", "dracula", "solarized-light"]
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(write_theme_config, picks))

    assert results == [True, True, True], "a concurrent write reported failure"
    assert [p.name for p in config_home.iterdir()] == ["config.json"], (
        "a temp file survived the race"
    )
    assert read_theme_config().theme in picks


def test_write_leaves_no_temp_file_behind(config_home: Path) -> None:
    write_theme_config("monokai")
    write_theme_config("dracula")
    assert sorted(p.name for p in config_home.iterdir()) == ["config.json"]


def test_a_missing_config_defaults_to_system_silently(
    config_home: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """That is the first run."""
    assert read_theme_config().theme == "system"
    assert capsys.readouterr().err == ""


def test_a_config_that_exists_but_cannot_be_read_warns(
    config_home: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Unlike a missing one.

    A directory where the file belongs fails with something that is not
    "no such file", on any platform. This is the branch that separates "first
    run" from "something is wrong" — invert the check and every first run warns.
    """
    (config_home / "config.json").mkdir()
    assert read_theme_config().theme == "system"
    assert "could not read" in capsys.readouterr().err


def test_a_malformed_config_degrades_to_system_without_raising(
    config_home: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    (config_home / "config.json").write_text("{ not json at all", encoding="utf-8")
    assert read_theme_config().theme == "system"
    assert list_themes().selected == "system"
    assert "malformed" in capsys.readouterr().err


def test_valid_json_of_the_wrong_shape_degrades_to_system(config_home: Path) -> None:
    (config_home / "config.json").write_text('["dracula"]', encoding="utf-8")
    assert read_theme_config().theme == "system"

    (config_home / "config.json").write_text('{"theme":7}', encoding="utf-8")
    assert read_theme_config().theme == "system"


def test_a_stale_saved_id_falls_back_to_system(config_home: Path) -> None:
    """Rather than leaving the page unstyled."""
    (config_home / "config.json").write_text('{"theme":"from-a-future-version"}', encoding="utf-8")
    listing = list_themes()
    # read_theme_config reports what is on disk; list_themes is where it resolves.
    assert read_theme_config().theme == "from-a-future-version"
    assert listing.selected == "system"
    assert len(listing.themes) == 5


def test_an_unwritable_config_directory_warns_and_returns_false(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """It never raises.

    A file where a directory needs to be: mkdir cannot succeed, on any platform.
    """
    blocker = tmp_path / "blocker"
    blocker.write_text("not a directory", encoding="utf-8")
    monkeypatch.setenv("REVGATE_CONFIG_DIR", str(blocker / "revgate"))

    assert write_theme_config("dracula") is False
    # The read path has to survive the same directory.
    assert read_theme_config().theme == "system"
    assert "could not save theme" in capsys.readouterr().err


def test_list_themes_returns_a_saved_built_in_selected_with_every_palette(
    config_home: Path,
) -> None:
    write_theme_config("solarized-light")
    listing = list_themes()
    assert listing.selected == "solarized-light"
    assert [t.id for t in listing.themes] == [t.id for t in BUILTIN_THEMES]


def test_system_is_a_real_saved_value_not_just_the_missing_config_default(
    config_home: Path,
) -> None:
    write_theme_config("dracula")
    write_theme_config("system")
    assert list_themes().selected == "system"
