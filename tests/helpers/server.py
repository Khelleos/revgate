"""HTTP helpers for the server suite.

The tests drive a real waitress on a random port rather than Flask's test
client, for four reasons: the DNS-rebinding cases need an arbitrary `Host`
header, one case needs an HTTP/1.0 GET with no Host at all (which `http.client`
cannot speak), the 413 case depends on waitress draining the body before Flask
raises, and the concurrent-staging case needs real threads.

`http.client` and `socket` from the standard library only — no `requests`.
"""

import http.client
import json
import socket
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from revgate.server.app import ReviewContext, ReviewHandle, start_review_server
from revgate.shared.types import DiffFile, HookPayload

#: Nothing here should ever take this long; the cap turns a hang into a failure.
TIMEOUT = 10


@dataclass(slots=True)
class Res:
    """One response, kept as bytes so a contract can be asserted on exactly."""

    status: int
    body: bytes
    headers: dict[str, str]

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")

    def json(self) -> Any:
        return json.loads(self.body)

    def header(self, name: str) -> str | None:
        return self.headers.get(name.lower())


def make_file(path: str) -> DiffFile:
    """A changed file with no hunks — enough for the routes under test."""
    return DiffFile(
        old_path=path,
        new_path=path,
        path=path,
        is_new=False,
        is_deleted=False,
        is_renamed=False,
        is_binary=False,
        additions=1,
        deletions=0,
        hunks=[],
    )


def context(**overrides: Any) -> ReviewContext:
    """The default review context, with any field overridden."""
    fields: dict[str, Any] = {
        "payload": HookPayload(session_id="s1", timestamp=0, cwd="."),
        "branch": "main",
        "files": [make_file("src/app.ts")],
        "is_repo": False,
        "mode": "diff",
    }
    fields.update(overrides)
    return ReviewContext(**fields)


@contextmanager
def serve(ctx: ReviewContext | None = None) -> Iterator[ReviewHandle]:
    """Start a server that is always torn down."""
    handle = start_review_server(ctx if ctx is not None else context())
    try:
        yield handle
    finally:
        handle.close()


def port_of(url: str) -> int:
    parsed = urlsplit(url)
    assert parsed.port is not None
    return parsed.port


def _request(
    url: str, method: str = "GET", body: str | None = None, headers: dict[str, str] | None = None
) -> Res:
    parsed = urlsplit(url)
    assert parsed.hostname and parsed.port
    connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=TIMEOUT)
    try:
        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        return Res(
            status=response.status,
            body=response.read(),
            headers={k.lower(): v for k, v in response.getheaders()},
        )
    finally:
        connection.close()


def get(url: str) -> Res:
    return _request(url, "GET")


def post(url: str, body: str) -> Res:
    """POST the way our own page does.

    A browser attaches Origin to every `fetch`, and the server requires it on
    POST (an origin-less POST is how a cross-site form forges a verdict), so the
    tests have to send what the page would.
    """
    parsed = urlsplit(url)
    origin = f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"
    return _request(url, "POST", body, {"Origin": origin, "Content-Type": "application/json"})


def post_with_origin(url: str, body: str, origin: str | None) -> Res:
    """POST with an arbitrary Origin, or none at all."""
    headers = {"Content-Type": "application/json"}
    if origin is not None:
        headers["Origin"] = origin
    return _request(url, "POST", body, headers)


def raw_get(port: int, path: str, host: str) -> Res:
    """A GET with an arbitrary Host header.

    `http.client` would otherwise substitute its own, so the DNS-rebinding case
    — where the browser sends the attacker's hostname to our loopback port —
    can only be reproduced by setting it explicitly.
    """
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=TIMEOUT)
    try:
        connection.putrequest("GET", path, skip_host=True, skip_accept_encoding=True)
        connection.putheader("Host", host)
        connection.endheaders()
        response = connection.getresponse()
        return Res(
            status=response.status,
            body=response.read(),
            headers={k.lower(): v for k, v in response.getheaders()},
        )
    finally:
        connection.close()


def http10_get(port: int, path: str) -> Res:
    """An HTTP/1.0 GET with no Host header, written straight onto a socket.

    This is the only way to reach the "authority is None" escape in the loopback
    guard: Host is mandatory in HTTP/1.1, and `http.client` cannot speak 1.0.
    """
    with socket.create_connection(("127.0.0.1", port), timeout=TIMEOUT) as sock:
        sock.sendall(f"GET {path} HTTP/1.0\r\n\r\n".encode())
        raw = b""
        while chunk := sock.recv(4096):
            raw += chunk

    head, _, body = raw.partition(b"\r\n\r\n")
    lines = head.split(b"\r\n")
    status = int(lines[0].split(b" ")[1]) if len(lines[0].split(b" ")) > 1 else 0
    headers = {}
    for line in lines[1:]:
        name, _, value = line.partition(b": ")
        headers[name.decode().lower()] = value.decode()
    return Res(status=status, body=body, headers=headers)
