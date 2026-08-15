"""The waitress lifecycle, and the only file that touches a waitress private attribute.

`wasyncore` is not thread-safe, and `server.run()` never returns after `close()`
leaves the trigger in the socket map. So one thread owns the loop and the
shutdown, and every private name waitress exposes is confined here: `_map`,
`active_channels`, `trigger`, `task_dispatcher`, and `total_outbufs_len`.
"""

import threading
import time
from dataclasses import dataclass
from typing import Any, Protocol, cast

from waitress import wasyncore
from waitress.server import BaseWSGIServer, create_server

from revgate.shared.log import warn
from revgate.shared.types import ReviewSubmission

#: How long one turn of the socket loop blocks. Also the shutdown granularity.
LOOP_TIMEOUT = 0.1

#: How long `close()` waits for a written response to reach the socket.
DRAIN_DEADLINE = 0.5

_DRAIN_POLL = 0.005


class _WaitressServer(Protocol):
    """Exactly the waitress surface this project uses, private names included.

    `types-waitress` does not describe these, so they are declared once here
    rather than suppressed at each of the five call sites. Anything this
    protocol does not name is off limits to the rest of the project.
    """

    #: A *str* on waitress 3.0.2, despite the name.
    effective_port: str
    #: fd -> channel, for the drain check.
    active_channels: dict[int, Any]
    #: The worker pool that runs the WSGI application.
    task_dispatcher: Any
    #: fd -> dispatcher, the socket map `wasyncore.loop` turns.
    _map: dict[int, Any]

    def close(self) -> None: ...


class ServerStartError(Exception):
    """The listener could not be bound.

    Unhandled this escapes `main()` and fails the hook closed, so it is caught
    and reported by the caller.
    """


class ServerClosed(Exception):  # noqa: N818 — a control-flow signal, not a fault
    """The server closed before a review was submitted."""


@dataclass(slots=True)
class PortHolder:
    """The bound port, readable by the application once `create_server` returns.

    `create_server` binds during construction, so the port is known before a
    single request can be served — no mutable closure needed.
    """

    port: int = 0


class SubmissionGate:
    """The verdict the review is waiting for, or the reason there will not be one."""

    def __init__(self) -> None:
        self._done = threading.Event()
        self._lock = threading.Lock()
        self._value: ReviewSubmission | None = None
        self._error: Exception | None = None

    def resolve(self, value: ReviewSubmission) -> None:
        """Record the submitted verdict. The first call wins."""
        with self._lock:
            if self._done.is_set():
                return
            self._value = value
            self._done.set()

    def reject(self, error: Exception) -> None:
        """Record why no verdict is coming.

        A no-op once `resolve` has run, because `close()` always runs and would
        otherwise turn an accepted verdict into "the server closed first".
        """
        with self._lock:
            if self._done.is_set():
                return
            self._error = error
            self._done.set()

    @property
    def settled(self) -> bool:
        return self._done.is_set()

    def wait(self) -> ReviewSubmission:
        """Block until a verdict arrives, or raise the reason it will not."""
        self._done.wait()
        with self._lock:
            if self._value is not None:
                return self._value
            raise self._error or ServerClosed("server closed before submission")


class ReviewServer:
    """A bound, running waitress server and the handle that shuts it down."""

    def __init__(
        self, server: _WaitressServer, thread: threading.Thread, stop: threading.Event
    ) -> None:
        self._server = server
        self._thread = thread
        self._stop = stop
        self._closed = False
        self.port = int(server.effective_port)
        self.url = f"http://127.0.0.1:{self.port}/"

    def _pending_output(self) -> int:
        """Bytes still queued on open channels.

        `getattr(..., 0)` so a waitress attribute change degrades to "drain
        nothing" rather than raising during shutdown.
        """
        channels = list(self._server.active_channels.values())
        return sum(getattr(channel, "total_outbufs_len", 0) for channel in channels)

    def _drain(self) -> None:
        """Let a written response reach the socket before the listener goes away.

        `POST /api/submit` answers 200 and only then resolves the gate, so
        `close()` follows within microseconds. A force-close there truncates the
        browser's response for a verdict that was in fact accepted.
        """
        deadline = time.monotonic() + DRAIN_DEADLINE
        while time.monotonic() < deadline:
            if not self._pending_output():
                return
            time.sleep(_DRAIN_POLL)

    def close(self) -> None:
        """Stop serving and release the port. Safe to call twice."""
        if self._closed:
            return
        self._closed = True
        # Drained first, while the loop thread is still turning: it is the loop
        # that actually flushes the socket.
        self._drain()
        self._stop.set()
        # The loop blocks up to LOOP_TIMEOUT per turn; give it a few of those.
        self._thread.join(timeout=LOOP_TIMEOUT * 20)
        try:
            self._server.task_dispatcher.shutdown()
        except Exception as err:  # noqa: BLE001 — shutdown is best-effort by definition
            warn(f"review server task shutdown: {err}")
        self._server.close()
        # Closing the listener is not enough: without this, a browser keep-alive
        # socket holds the port open.
        wasyncore.close_all(map=self._server._map, ignore_all=True)  # noqa: SLF001


def start_server(app: Any, holder: PortHolder) -> ReviewServer:
    """Bind the application on a random loopback port and start serving.

    `create_server` is called directly rather than `waitress.serve`, because the
    second one runs `logging.basicConfig()` and would take over the root logger.
    """
    try:
        raw_server = create_server(
            app,
            host="127.0.0.1",
            port=0,
            # The review page issues a handful of requests; more threads would
            # only add shutdown latency.
            threads=4,
            clear_untrusted_proxy_headers=True,
            ident=None,
        )
    except OSError as err:
        raise ServerStartError(f"could not start review server: {err}") from err
    if not isinstance(raw_server, BaseWSGIServer):
        # One host and one port always give a single-socket server; the
        # multi-socket variant carries neither `effective_port` nor `_map`.
        raise ServerStartError("waitress returned a multi-socket server")
    server = cast("_WaitressServer", raw_server)

    # `effective_port` is a *str* on waitress 3.0.2, so it is coerced here rather
    # than compared against an int in the Host guard.
    holder.port = int(server.effective_port)

    stop = threading.Event()

    def loop() -> None:
        while not stop.is_set():
            wasyncore.loop(timeout=LOOP_TIMEOUT, map=server._map, count=1)  # noqa: SLF001

    thread = threading.Thread(target=loop, name="revgate-server", daemon=True)
    thread.start()
    return ReviewServer(server, thread, stop)
