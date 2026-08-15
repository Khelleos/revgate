"""Opening the review page. Never raises: the hook fails closed on a non-zero exit."""

import subprocess
import sys

from revgate.shared.log import warn

_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0


def _opener(url: str) -> list[str]:
    # Read into a plain `str` so the checker does not narrow these branches
    # away to whichever platform it happens to be running on.
    platform: str = sys.platform
    if platform == "win32":
        # `start` is a cmd builtin; the empty title arg avoids quoting pitfalls.
        return ["cmd", "/c", "start", "", url]
    if platform == "darwin":
        return ["open", url]
    return ["xdg-open", url]


def open_browser(url: str) -> None:
    """Open `url` in the platform's default browser. Never raises."""
    try:
        # Detached and with every stream closed: the opener outlives this call,
        # and an inherited stdout would corrupt the output contract.
        subprocess.Popen(
            _opener(url),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=_CREATE_NO_WINDOW,
            start_new_session=sys.platform != "win32",
        )
    except OSError as err:
        # A missing opener is the ordinary case on a headless machine. The URL
        # is on stderr already, so the reviewer can still reach the page.
        warn(f"could not auto-open browser: {err}")
