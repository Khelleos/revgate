"""HTTP odds and ends: MIME types, the frame headers, and the loopback guard."""

import re
from urllib.parse import urlsplit

#: Content types for everything `public/` holds; anything else is served as bytes.
MIME: dict[str, str] = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
}

#: Cap on a request body; a review's comments are prose typed by a human.
MAX_BODY_BYTES = 4 * 1024 * 1024

#: Refuse to be framed: a framed UI turns a stray click into a guard-passing approval.
FRAME_HEADERS: dict[str, str] = {
    "content-security-policy": "frame-ancestors 'none'",
    "x-frame-options": "DENY",
}

_HAS_SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*://", re.IGNORECASE)

_LOOPBACK_NAMES = frozenset({"127.0.0.1", "localhost", "::1"})


def is_loopback_authority(authority: str | None, port: int) -> bool:
    """Whether `authority` names our own loopback listener.

    Takes a `host:port` or a full origin URL. One answer for the Host and Origin
    guards alike, so they cannot drift; see the trust-boundary rule in agents.md.

    `urllib` has no WHATWG IPv4 canonicalisation, so a short form such as
    `127.1` is not folded to `127.0.0.1` and is refused outright. That makes the
    guard stricter, never weaker.
    """
    if authority is None:
        return True
    # A bare `host:port` is not a URL; a full origin already carries its scheme.
    candidate = authority if _HAS_SCHEME.match(authority) else f"http://{authority}"
    try:
        parts = urlsplit(candidate)
        hostname = parts.hostname
        actual_port = parts.port
    except ValueError:
        # A malformed authority (a non-numeric or out-of-range port) is refused.
        return False
    if hostname is None:
        return False
    # `urlsplit` already strips the brackets from an IPv6 literal, but a raw
    # value can still carry them.
    name = hostname.strip("[]")
    return actual_port == port and name in _LOOPBACK_NAMES
