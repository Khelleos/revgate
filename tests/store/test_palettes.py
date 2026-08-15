"""The built-in palettes.

The drift guard against `public/app.css` is deliberately not ported: it belongs
to the page's own build, and `app.css` hard-copies two palettes by hand. When a
built-in is retuned, re-check that file by eye.
"""

import re

from revgate.store.palettes import BUILTIN_THEMES, PALETTE_KEYS, is_known_theme_id

_HEX = re.compile(r"^#[0-9a-f]{6}([0-9a-f]{2})?$")


def test_five_built_ins_ship_each_with_a_unique_id_and_both_types_represented() -> None:
    assert len(BUILTIN_THEMES) == 5
    assert [t.id for t in BUILTIN_THEMES] == [
        "dark-modern",
        "light-modern",
        "monokai",
        "solarized-light",
        "dracula",
    ]
    assert len({t.id for t in BUILTIN_THEMES}) == 5
    for theme in BUILTIN_THEMES:
        assert theme.name, f"{theme.id} has no display name"
        assert theme.type in {"dark", "light"}, f"{theme.id} has a bad type"
    assert any(t.type == "light" for t in BUILTIN_THEMES)
    assert any(t.type == "dark" for t in BUILTIN_THEMES)


def test_every_built_in_defines_exactly_the_palette_keys() -> None:
    """Nothing merges over a base."""
    expected = sorted(PALETTE_KEYS)
    for theme in BUILTIN_THEMES:
        assert sorted(theme.colors) == expected, (
            f"{theme.id} does not define exactly the palette keys"
        )
        for key, value in theme.colors.items():
            assert _HEX.match(value), f"{theme.id} {key} is not a hex colour"
    # --mono is the font stack, which is not themeable.
    assert "--mono" not in PALETTE_KEYS


def test_every_selection_colour_is_translucent() -> None:
    """So the diff tint shows through."""
    for theme in BUILTIN_THEMES:
        assert len(theme.colors["--sel"]) == 9, f"{theme.id} --sel has no alpha channel"


def test_is_known_theme_id_covers_the_built_ins_and_system_and_nothing_else() -> None:
    assert is_known_theme_id("system") is True
    for theme in BUILTIN_THEMES:
        assert is_known_theme_id(theme.id) is True
    assert is_known_theme_id("nope") is False
    assert is_known_theme_id("") is False
    assert is_known_theme_id(None) is False
    assert is_known_theme_id(42) is False
