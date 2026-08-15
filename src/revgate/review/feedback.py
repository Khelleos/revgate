"""Where a comment points, and the prompt a blocked plan review hands back to the agent."""

from revgate.shared.types import DiffFile, HookDecision, LineComment, ReviewSubmission


def group_comments_by_file(comments: list[LineComment]) -> dict[str, list[LineComment]]:
    """Group comments by file, in submission order. Shared, so both contracts order alike."""
    by_file: dict[str, list[LineComment]] = {}
    for comment in comments:
        by_file.setdefault(comment.file, []).append(comment)
    return by_file


def _is_addressable_line(value: object) -> bool:
    """True only for a whole number that some line of some file could actually be.

    Typed on `object` so the guard survives a value that came off `json.loads`
    rather than through `normalize_comment` — a float, or a NaN, is not a line
    number, and treating it as one points the agent at a line no file has.
    """
    return isinstance(value, int) and not isinstance(value, bool) and value >= 1


def is_file_level_comment(comment: LineComment) -> bool:
    """True for the file-level sentinel `normalize_comment` produces."""
    return not _is_addressable_line(comment.start_line)


def location_header(comment: LineComment) -> str:
    """Where a comment points, in the form BOTH contracts render.

    `path:LINE (+)` on the new side, `(-)` on the old, a bare `path` when
    file-level. Shared, because a diff has two line numberings and the marker is
    what tells them apart.
    """
    if is_file_level_comment(comment):
        return comment.file
    marker = "(-)" if comment.side == "old" else "(+)"
    span = (
        f"{comment.start_line}-{comment.end_line}"
        if comment.end_line > comment.start_line
        else f"{comment.start_line}"
    )
    return f"{comment.file}:{span} {marker}"


def build_decision(review: ReviewSubmission, files: list[DiffFile]) -> HookDecision:
    """The HookDecision for a submitted plan review.

    approve -> allow, request_changes -> block with the feedback prompt.
    Plan reviews only.
    """
    if review.decision == "approve":
        return HookDecision(decision="allow")
    return HookDecision(decision="block", reason=_render_prompt(review, files))


def _range_lines(
    files: list[DiffFile], file: str, start_line: int, end_line: int, side: str
) -> list[str]:
    """The code lines a comment spans, in order, for quoting back to the agent."""
    # The display path wins: `git mv a b` plus a fresh `a` puts both in the list,
    # and an equal-priority match would quote `b`'s code under `a`.
    match = next((f for f in files if f.path == file), None)
    if match is None:
        match = next((f for f in files if file in (f.new_path, f.old_path)), None)
    if match is None:
        return []
    out: list[str] = []
    for hunk in match.hunks:
        for line in hunk.lines:
            number = line.new_line if side == "new" else line.old_line
            if number is not None and start_line <= number <= end_line:
                out.append(line.content)
    return out


def _render_prompt(review: ReviewSubmission, files: list[DiffFile]) -> str:
    out: list[str] = [
        "A human reviewer looked at the plan you proposed and left the review below.",
        "Revise the plan to address every point before you start implementing, "
        "then briefly note what you changed.",
        "",
        "## Review verdict: REQUEST CHANGES",
        "",
    ]

    if review.summary.strip():
        out += ["## Overall summary", review.summary.strip(), ""]

    if review.comments:
        out.append("## Plan comments")
        for file, comments in group_comments_by_file(review.comments).items():
            out.append(f"\n### {file}")
            for comment in comments:
                # The location comes from the shared renderer, so this prose and
                # the annotation records describe the same comment the same way.
                file_level = is_file_level_comment(comment)
                is_range = not file_level and comment.end_line > comment.start_line
                location = location_header(comment)
                code = (
                    []
                    if file_level
                    else _range_lines(
                        files, comment.file, comment.start_line, comment.end_line, comment.side
                    )
                )
                if is_range and code:
                    out += [f"- **{location}**", "  ```"]
                    out += [f"  {line}" for line in code]
                    out.append("  ```")
                else:
                    code_ref = f"  (`{code[0].strip()}`)" if code else ""
                    out.append(f"- **{location}**{code_ref}")
                out += [f"  {line}" for line in comment.body.strip().split("\n")]
        out.append("")

    if not review.summary.strip() and not review.comments:
        out.append(
            "The reviewer requested changes but left no specific notes. Ask them what to change."
        )

    return "\n".join(out)
