"""The review UI and its `/api/*` routes.

Both guards run in `before_request`, so a route added later inherits them, and
the frame headers go on in `after_request`, so a 404 and an error-handler
response carry them too. See the trust-boundary rule in agents.md.
"""

import json
import logging
import os
import threading
from dataclasses import dataclass, field
from importlib.resources import files
from pathlib import Path
from typing import Any, Literal

from flask import Flask, Response, request

from revgate.git.staging import get_stage_states, set_staged
from revgate.server.http import FRAME_HEADERS, MAX_BODY_BYTES, MIME, is_loopback_authority
from revgate.server.normalize import normalize_submission
from revgate.server.wsgi import (
    PortHolder,
    ReviewServer,
    ServerClosed,
    SubmissionGate,
    start_server,
)
from revgate.shared.jsonio import dumps_compact, to_wire
from revgate.shared.log import log, warn
from revgate.shared.types import DiffFile, HookPayload, StageState
from revgate.store.palettes import is_known_theme_id
from revgate.store.theme_config import list_themes, write_theme_config

#: The review page's assets, shipped as package data.
PUBLIC_DIR = Path(str(files("revgate") / "public"))

#: One lock per process for index work: `.git/index.lock` makes a concurrent
#: `git add`/`reset` fail outright, and a mid-write snapshot describes neither
#: state.
_INDEX_LOCK = threading.Lock()

_ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]


@dataclass(slots=True)
class ReviewContext:
    """Everything the review page renders, served as-is by `GET /api/review`."""

    payload: HookPayload
    branch: str | None
    files: list[DiffFile] = field(default_factory=list)
    is_repo: bool = False
    #: "diff" reviews the working tree; "plan" reviews a proposed plan document.
    mode: Literal["diff", "plan"] = "diff"
    #: Whether the stage toggle applies. Absent by default, so nothing opts in
    #: by accident.
    can_stage: bool | None = None
    #: Short heading for a plan review (mode == "plan" only).
    plan_title: str | None = None
    #: What was diffed, e.g. `main..feature` (mode == "diff" only).
    scope: str | None = None
    note: str | None = None
    #: Something on screen changes what approving means. Rendered as a banner.
    warning: str | None = None


@dataclass(slots=True)
class ReviewHandle:
    """A running review server and the verdict it is waiting for."""

    url: str
    gate: SubmissionGate
    server: ReviewServer

    def close(self) -> None:
        """Stop serving. `wait()` then raises `ServerClosed` if nothing was submitted."""
        self.server.close()
        self.gate.reject(ServerClosed("server closed before submission"))


class _WarnHandler(logging.Handler):
    """Forward waitress's own logging through `warn`, so it lands on stderr only."""

    def emit(self, record: logging.LogRecord) -> None:
        warn(f"review server: {record.getMessage()}")


def _json(status: int, body: Any) -> Response:
    """A JSON response with no incidental whitespace.

    Never `flask.jsonify`: it pretty-prints and appends a trailing newline.
    """
    return Response(
        dumps_compact(to_wire(body)),
        status=status,
        content_type="application/json; charset=utf-8",
    )


#: Returned by `_body_json` when the body is not JSON at all. `None` cannot
#: serve here: a body of literal `null` parses fine and means something else.
_INVALID = object()


def _body_json() -> Any:
    """Parse the request body, telling a JSON `null` apart from an unparseable one.

    `request.get_json()` collapses both to `None`, and the two take different
    branches: `null` reaches the shape checks, garbage is a 400 straight away.
    """
    raw = request.get_data(cache=False)
    if not raw:
        return _INVALID
    try:
        return json.loads(raw)
    except ValueError:
        return _INVALID


def _text(status: int, body: str) -> Response:
    return Response(body, status=status, content_type="text/plain; charset=utf-8")


def _static(pathname: str) -> Response:
    """Serve one file out of `public/`, or 404."""
    wanted = "/index.html" if pathname == "/" else pathname
    # `normpath` first, then strip every leading separator: on POSIX
    # `os.path.join(base, "/app.css")` *replaces* the base, which would serve
    # from the filesystem root.
    relative = os.path.normpath(wanted).lstrip("\\/")
    target = PUBLIC_DIR / relative
    if not str(target).startswith(str(PUBLIC_DIR)):
        return _text(403, "forbidden")
    try:
        data = target.read_bytes()
    except OSError:
        return _text(404, "not found")
    content_type = MIME.get(target.suffix, "application/octet-stream")
    return Response(data, status=200, content_type=content_type)


def _stage_route(  # noqa: PLR0911 — each return is a distinct, documented refusal
    ctx: ReviewContext, stage: bool
) -> Response:
    if not ctx.is_repo:
        return _json(409, {"error": "not a git repository"})
    # The route is reachable even where the UI hides the toggle, and staging
    # there would touch content outside the reviewed range.
    if not ctx.can_stage:
        return _json(409, {"error": "staging does not apply to this review scope"})

    body = _body_json()
    # A body of `null` has no `.file` to read at all, so it is refused here
    # rather than reported as a missing field.
    if body is _INVALID or body is None:
        return _json(400, {"error": "invalid JSON"})
    raw = body.get("file") if isinstance(body, dict) else None
    file = "" if raw is None else str(raw)
    if not file:
        return _json(400, {"error": "missing file"})
    # `--` stops a flag or a ref, but not pathspec magic: `:/` matches the whole
    # repository. Accept only a path from this review.
    if not any(f.path == file for f in ctx.files):
        return _json(400, {"error": "unknown file"})

    # Read and write are one critical section; nothing writes a response inside it.
    with _INDEX_LOCK:
        # A conflict has no split to toggle, and unstaging drops its stages.
        before = get_stage_states(ctx.payload.cwd)
        if before.get(file) == "unmerged":
            return _json(
                409,
                {"error": "unmerged path — resolve the conflict in git first", "states": before},
            )
        states: dict[str, StageState]
        try:
            states = set_staged(ctx.payload.cwd, file, stage)
        except Exception as err:  # noqa: BLE001 — reported as JSON, never as a plain-text 500
            # JSON, not the outer 500: the page reads the body before the status.
            # `before` snaps the checkbox back correctly.
            warn(f"stage request failed: {err}")
            return _json(500, {"error": str(err), "states": before})

    log(f"{'staged' if stage else 'unstaged'} {file}")
    return _json(200, {"states": states})


def _theme_route() -> Response:
    body = _body_json()
    if body is _INVALID:
        return _json(400, {"error": "invalid JSON"})
    # Outside the parse: `.id` on a valid-JSON `null` is not an unparseable body.
    theme_id = body.get("id") if isinstance(body, dict) else None
    # Set membership is the whole surface: the id is the only user value here.
    if not is_known_theme_id(theme_id):
        return _json(400, {"error": "unknown theme"})
    # A failed write goes to stderr only: the page has already applied the
    # palette, and an error would make it undo a visible change.
    write_theme_config(str(theme_id))
    return _json(200, {"ok": True})


def _submit_route(ctx: ReviewContext, gate: SubmissionGate) -> Response:
    body = _body_json()
    if body is _INVALID:
        return _json(400, {"error": "invalid JSON"})
    submission = normalize_submission(body, {f.path for f in ctx.files})
    if submission is None:
        # Keeps the review pending: a dropped verdict is not an approval.
        return _json(400, {"error": "expected { decision: 'approve' | 'request_changes', … }"})
    response = _json(200, {"ok": True})
    log(f"review submitted: {submission.decision} ({len(submission.comments)} comments)")
    gate.resolve(submission)
    return response


def create_app(ctx: ReviewContext, holder: PortHolder, gate: SubmissionGate) -> Flask:
    """Build the review application. `holder` carries the bound port for the Host guard."""
    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = MAX_BODY_BYTES
    # `/api//submit` must not be folded into `/api/submit`: the guards and the
    # routing table are read literally.
    app.url_map.merge_slashes = False
    # Flask's own logger would otherwise reach stdout through the root handler.
    app.logger.handlers.clear()
    app.logger.propagate = False

    @app.before_request
    def _guards() -> Response | None:
        # A missing Origin on a POST is refused; a missing Host is not, because a
        # cross-site form POST sends no Origin but carries a genuine loopback Host.
        host = request.headers.get("Host")
        if not is_loopback_authority(host, holder.port):
            warn(f"rejected request to {request.path} for host {host}")
            return _json(403, {"error": "unexpected host"})
        if request.method == "POST":
            origin = request.headers.get("Origin")
            if origin is None or not is_loopback_authority(origin, holder.port):
                warn(
                    f"rejected cross-origin POST to {request.path} "
                    f"from {origin if origin is not None else 'no origin'}"
                )
                return _json(403, {"error": "cross-origin request rejected"})
        return None

    @app.after_request
    def _frame_headers(response: Response) -> Response:
        # Here rather than per route: a 404 and an error-handler response both
        # come back through `finalize_request`, so both get the headers.
        for name, value in FRAME_HEADERS.items():
            response.headers[name] = value
        return response

    @app.errorhandler(413)
    def _too_large(_error: Any) -> Response:
        warn(f"rejected oversized request to {request.path}: body exceeds {MAX_BODY_BYTES} bytes")
        return _json(413, {"error": "request body too large"})

    @app.errorhandler(500)
    def _internal(error: Any) -> Response:
        warn(f"request error: {error}")
        return _text(500, "internal error")

    # ONE catch-all view, dispatching on the method itself. Per-route `methods`
    # would answer 405 where the contract says a GET to an API path falls
    # through to the static handler and 404s.
    @app.route("/", defaults={"path": ""}, methods=_ALL_METHODS)
    @app.route("/<path:path>", methods=_ALL_METHODS)
    def _dispatch(path: str) -> Response:  # noqa: ARG001 — Flask binds it; `request.path` is read
        pathname = request.path
        method = request.method

        if pathname == "/api/review" and method == "GET":
            return _json(200, ctx)
        # Every palette at once, so a loaded page cannot end up half-themed.
        if pathname == "/api/themes" and method == "GET":
            return _json(200, list_themes())
        if pathname == "/api/theme" and method == "POST":
            return _theme_route()
        if pathname in ("/api/stage", "/api/unstage") and method == "POST":
            return _stage_route(ctx, pathname == "/api/stage")
        if pathname == "/api/submit" and method == "POST":
            return _submit_route(ctx, gate)

        return _static(pathname)

    return app


def start_review_server(ctx: ReviewContext) -> ReviewHandle:
    """Bind the review UI on a random loopback port and serve it until `close()`."""
    # Never `logging.basicConfig`: waitress would otherwise take over the root
    # logger, and its output would reach stdout.
    waitress_logger = logging.getLogger("waitress")
    waitress_logger.propagate = False
    if not any(isinstance(h, _WarnHandler) for h in waitress_logger.handlers):
        waitress_logger.addHandler(_WarnHandler())

    holder = PortHolder()
    gate = SubmissionGate()
    app = create_app(ctx, holder, gate)
    server = start_server(app, holder)
    return ReviewHandle(url=server.url, gate=gate, server=server)
