"""The data model.

Every record is a `@dataclass(slots=True)`. A closed set of string values is a
`Literal` rather than a `StrEnum`, because these values go on the wire unchanged
and are compared against strings that came out of `json.loads`. A wire shape
whose keys are already camelCase is a `TypedDict`.
"""

from dataclasses import dataclass, field
from typing import Literal, NotRequired, TypedDict

# --- hook payloads and decisions -------------------------------------------


@dataclass(slots=True)
class HookPayload:
    """What Copilot pipes to a hook on stdin; `read_hook_payload` normalizes both forms."""

    session_id: str
    timestamp: int | str
    cwd: str
    #: The tool about to run. Only `exit_plan_mode` is gated.
    tool_name: str | None = None
    #: Plan markdown. Present => review the plan instead of a git diff.
    plan: str | None = None


@dataclass(slots=True)
class HookDecision:
    """A review's verdict in hook terms; "block" carries the feedback in `reason`. Internal only."""

    decision: Literal["block", "allow"]
    reason: str | None = None


class PermissionDecision(TypedDict):
    """What a `preToolUse` hook writes to stdout.

    Copilot also accepts "ask"; revgate never emits it. The keys are the wire
    keys, so this dict is serialized as-is.
    """

    permissionDecision: Literal["allow", "deny"]
    permissionDecisionReason: NotRequired[str]


# --- the diff model ---------------------------------------------------------

#: "plan" lines belong to a synthetic plan document, not a git diff.
LineType = Literal["add", "del", "context", "plan"]

#: Staged in full, in part, not at all (or untracked), or conflicted — which has no toggle.
StageState = Literal["yes", "partial", "no", "unmerged"]


@dataclass(slots=True)
class DiffLine:
    """One line of a hunk. The numbers are 1-based, and None where the line does not exist."""

    type: LineType
    content: str
    old_line: int | None
    new_line: int | None


@dataclass(slots=True)
class DiffHunk:
    """One `@@` hunk of a file's diff."""

    header: str
    old_start: int
    new_start: int
    lines: list[DiffLine] = field(default_factory=list)


@dataclass(slots=True)
class DiffFile:
    """One changed file, as the parser produces it and the UI renders it."""

    old_path: str
    new_path: str
    #: Display path, prefers the new path.
    path: str
    is_new: bool
    is_deleted: bool
    is_renamed: bool
    is_binary: bool
    additions: int
    deletions: int
    hunks: list[DiffHunk] = field(default_factory=list)
    #: Index/staging state; absent when the cwd isn't a git repo.
    staged: StageState | None = None


# --- what the user submits --------------------------------------------------


@dataclass(slots=True)
class LineComment:
    """A comment anchored to a line or a contiguous range of lines, GitHub-style."""

    file: str
    #: 1-based inclusive range; 0 on both means the whole file.
    start_line: int
    end_line: int
    side: Literal["new", "old"]
    body: str


@dataclass(slots=True)
class ReviewSubmission:
    """The review the user submits from the web UI."""

    decision: Literal["approve", "request_changes"]
    summary: str
    comments: list[LineComment] = field(default_factory=list)
