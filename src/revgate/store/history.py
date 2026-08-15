"""Archiving a review as markdown.

Every review that found something is archived under
`<history_dir>/<repo-name>/<timestamp>.md`, so it survives a hook timeout, a
closed terminal, or an agent that ignored the feedback. Nothing here raises.
"""

import os
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from revgate.git.exec import find_repo_root
from revgate.review.annotations import AnnotationMeta, render_annotations
from revgate.review.report import has_findings
from revgate.shared.jsonio import dumps_compact
from revgate.shared.log import log, warn
from revgate.shared.types import DiffFile, ReviewSubmission

#: How many `-N` suffixes to try before giving up on a free file name.
_MAX_NAME_ATTEMPTS = 100


@dataclass(slots=True)
class HistoryMeta:
    """What `save_history` needs beyond the review itself."""

    #: Where the review ran; used to find the repository name.
    cwd: str
    #: Copilot's session id (or "cli" for a skill-driven review).
    session_id: str | None = None
    #: Human-readable scope label, e.g. `main..feature`.
    scope: str | None = None
    branch: str | None = None
    mode: Literal["diff", "plan"] | None = None
    #: True when the untracked scan failed; the archive says so too.
    untracked_scan_failed: bool = False
    #: How many changed files were dropped for a line break in their path.
    dropped_paths: int = 0
    #: False when `--no-history` was passed.
    enabled: bool = True
    #: `--history-dir`; overrides the env var and the default location.
    history_dir: str | None = None
    #: Injectable clock, so tests get a deterministic file name.
    now: datetime | None = None


@dataclass(slots=True)
class HistoryDocumentContext:
    """The frontmatter facts for one archived review."""

    date: datetime
    repo: str
    session_id: str | None = None
    scope: str | None = None
    branch: str | None = None
    mode: Literal["diff", "plan"] | None = None
    untracked_scan_failed: bool = False
    dropped_paths: int = 0


def iso_z(moment: datetime) -> str:
    """A UTC ISO-8601 stamp with exactly 3 fractional digits and a `Z`.

    `datetime.isoformat()` gives 6 digits and `+00:00`, so the stamp is built by
    hand. The archive file name is derived from this, and both are contracts.
    """
    utc = moment.astimezone(UTC) if moment.tzinfo is not None else moment.replace(tzinfo=UTC)
    return f"{utc:%Y-%m-%dT%H:%M:%S}.{utc.microsecond // 1000:03d}Z"


def history_root(explicit: str | None = None) -> Path:
    """`--history-dir` beats `$REVGATE_HISTORY_DIR`, which beats `~/.revgate/history`."""
    directory = (explicit or "").strip() or (os.environ.get("REVGATE_HISTORY_DIR") or "").strip()
    if directory:
        return Path(directory).absolute()
    return Path.home() / ".revgate" / "history"


def sanitize_segment(name: str) -> str:
    """Reduce a repo name to one safe path segment, so a repo called `..` cannot climb out."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", name.strip())
    cleaned = re.sub(r"^[-.]+", "", cleaned)
    cleaned = re.sub(r"[-.]+$", "", cleaned)
    return cleaned or "no-repo"


def repo_segment(cwd: str) -> str:
    """The git toplevel's basename, sanitized; `no-repo` outside a repository.

    Via `find_repo_root`, so `core.quotePath=false` applies and a non-ASCII repo
    name is not archived under a C-quoted directory.
    """
    top = find_repo_root(cwd)
    return sanitize_segment(Path(top).name) if top else "no-repo"


def timestamp_name(moment: datetime) -> str:
    """File name for a review taken at `moment`: an ISO stamp with `:`/`.` made safe."""
    return re.sub(r"[:.]", "-", iso_z(moment)) + ".md"


def _yaml_value(value: str) -> str:
    """Quote a frontmatter value so the block stays parseable YAML.

    A plan scope is `plan: <title>`, and a title with its own colon would break
    the header.
    """
    return dumps_compact(value)


def render_history_document(
    review: ReviewSubmission, files: list[DiffFile], ctx: HistoryDocumentContext
) -> str:
    """The full markdown document: frontmatter header + the annotation records."""
    front = ["---", f"date: {iso_z(ctx.date)}", f"repo: {_yaml_value(ctx.repo)}"]
    front.append(f"mode: {ctx.mode or 'diff'}")
    if ctx.session_id:
        front.append(f"session: {_yaml_value(ctx.session_id)}")
    if ctx.scope:
        front.append(f"scope: {_yaml_value(ctx.scope)}")
    if ctx.branch:
        front.append(f"branch: {_yaml_value(ctx.branch)}")
    front += ["---", ""]

    return (
        "\n".join(front)
        + "\n"
        + render_annotations(
            review,
            files,
            AnnotationMeta(
                mode=ctx.mode,
                scope=ctx.scope,
                branch=ctx.branch,
                untracked_scan_failed=ctx.untracked_scan_failed,
                dropped_paths=ctx.dropped_paths,
            ),
        )
    )


def _write_unique(directory: Path, name: str, content: str) -> Path:
    """Write `content` under a name that isn't taken yet, and return the path."""
    stem, _, extension = name.rpartition(".")
    suffix = f".{extension}" if stem else ""
    stem = stem or name
    # Two reviews in one millisecond are far-fetched, but a collision would
    # silently overwrite the earlier one.
    for attempt in range(_MAX_NAME_ATTEMPTS):
        destination = directory / (name if attempt == 0 else f"{stem}-{attempt}{suffix}")
        try:
            # "x" is the exclusive-create mode: it fails rather than truncating.
            with destination.open("x", encoding="utf-8", newline="") as handle:
                handle.write(content)
        except FileExistsError:
            continue
        return destination
    raise OSError(f"could not find a free history file name in {directory}")


def save_history(review: ReviewSubmission, files: list[DiffFile], meta: HistoryMeta) -> str | None:
    """Persist a review that has something to act on, or return None. Never raises."""
    if meta.enabled is False:
        return None

    try:
        # Inside the try: a malformed submission must not turn "could not archive
        # this review" into a raised error the caller reads as "no review at all".
        if not has_findings(review):
            return None

        date = meta.now or datetime.now(UTC)
        repo = repo_segment(meta.cwd)
        directory = history_root(meta.history_dir) / repo
        directory.mkdir(parents=True, exist_ok=True)

        content = render_history_document(
            review,
            files,
            HistoryDocumentContext(
                date=date,
                repo=repo,
                session_id=meta.session_id,
                scope=meta.scope,
                branch=meta.branch,
                mode=meta.mode,
                untracked_scan_failed=meta.untracked_scan_failed,
                dropped_paths=meta.dropped_paths,
            ),
        )
        destination = _write_unique(directory, timestamp_name(date), content)
    except Exception as err:  # noqa: BLE001 — history is a convenience, never a cost
        # Losing it must never cost the caller a review.
        warn(f"could not save review history: {err}")
        return None
    log(f"review saved to {destination}")
    return str(destination)
