"""The `revgate review` command.

NOT a hook: no payload on stdin, no hook JSON on stdout, real exit codes. The
plan half reuses `gate_plan` from the hook module.
"""

import os
import time
from pathlib import Path

from revgate.cli.grammar import CliOptions
from revgate.cli.plan_hook import ReviewOutcome, gate_plan
from revgate.git.collect import collect_diff
from revgate.git.scope import ScopeError, describe_scope, filter_files
from revgate.git.staging import get_stage_states
from revgate.review.diff import parse_unified_diff
from revgate.review.report import ReviewOutcomeSummary, review_report
from revgate.server.app import ReviewContext, start_review_server
from revgate.server.browser import open_browser
from revgate.server.wsgi import ServerClosed
from revgate.shared.log import log, warn
from revgate.shared.streams import write_stdout
from revgate.shared.types import DiffFile, HookPayload
from revgate.store.history import HistoryMeta, save_history


def resolve_plan(options: CliOptions, cwd: str) -> str | None:
    """The plan text to review, or None when `--plan` was not asked for.

    `--plan <file>` beats `$REVGATE_PLAN_FILE`. Strict, because the skill reads
    exit 0 as "approved, start implementing" — a missing plan is bad usage.
    """
    if not options.plan:
        return None

    file = options.plan_file or os.environ.get("REVGATE_PLAN_FILE")
    if file:
        try:
            text = (Path(cwd) / file).read_text(encoding="utf-8", errors="replace")
        except OSError as err:
            raise ScopeError(f"could not read plan file {file}: {err}") from err
        # An existing-but-empty file is not a plan: reviewing a blank document
        # the reviewer can only approve is a sign-off on nothing.
        if text.strip():
            return text
        warn(f"plan file {file} is empty")
    raise ScopeError(
        "--plan was given but no plan text was found — pass a file or set $REVGATE_PLAN_FILE"
    )


def _deliver(text: str, options: CliOptions, cwd: str) -> None:
    """`--output` when asked, otherwise stdout.

    stdout is the only thing this command ever writes there, and never hook JSON.
    """
    if not options.output:
        write_stdout(text)
        return
    destination = Path(cwd) / options.output
    try:
        destination.write_text(text, encoding="utf-8", newline="")
    except OSError as err:
        # The human has already reviewed, and exit 1 reads as "no verdict".
        warn(f"could not write {destination}: {err}")
        warn("writing the annotations to stdout instead")
        write_stdout(text)
        return
    log(f"annotations written to {destination}")


def run_review_command(options: CliOptions) -> int:
    """`revgate review` — the on-demand entry point the skill drives.

    Returns the exit code; it never sets it itself.
    """
    cwd = str(Path.cwd())
    payload = HookPayload(session_id="cli", timestamp=int(time.time() * 1000), cwd=cwd)

    plan_text = resolve_plan(options, cwd)
    outcome = (
        gate_plan(payload, plan_text, options)
        if plan_text is not None
        else review_diff(payload, options)
    )

    report = review_report(
        outcome.summary, "plan" if plan_text is not None else "diff", options.exit_code_on_comments
    )
    if report.kind == "interrupted":
        warn("no verdict was captured — reporting an error rather than an approval")
    elif report.kind == "not-a-repo":
        warn("not a git repository — nothing was reviewed")
        warn("run `revgate review` from inside a repository")
    elif report.kind == "scan-failed":
        warn("the untracked-file scan failed — reporting an error rather than an approval")
    elif report.kind == "dropped-paths":
        warn("every changed file was dropped for a line break in its path — not an approval")
    _deliver(report.text, options, cwd)
    return report.exit_code


def review_diff(payload: HookPayload, options: CliOptions) -> ReviewOutcome:
    """Open the diff review page and resolve to an outcome. Never raises."""
    cwd = payload.cwd or str(Path.cwd())
    log(f"session {payload.session_id} — reviewing {describe_scope(options.scope)} in {cwd}")

    repo = collect_diff(cwd, options.scope)
    # Seeded with the untracked files `collect_diff` refused: one count, one report.
    dropped_paths = repo.dropped_untracked

    def on_drop(_file: DiffFile) -> None:
        nonlocal dropped_paths
        dropped_paths += 1

    changed = parse_unified_diff(repo.unified, on_drop)
    files = filter_files(changed, options.scope)

    # An -I/-X pair matching nothing is otherwise an empty scope. Carried on the
    # outcome, because stderr does not reach an agent reading only `-o <file>`.
    filtered_out = len(changed) if changed and not files else 0
    if filtered_out:
        warn(
            f"every one of the {len(changed)} changed file(s) was removed by the path "
            f"filters — nothing is being reviewed in {repo.scope_label}"
        )
        warn("-I/--include and -X/--exclude prefixes are relative to the repository root")

    if not files:
        note = (
            f"No changes to review in {repo.scope_label}."
            if repo.is_repo
            else "Not a git repository — no diff available."
        )
        log(f"{note} Allowing.")
        return ReviewOutcome(
            summary=ReviewOutcomeSummary(
                review=None,
                files=files,
                scope=repo.scope_label,
                branch=repo.branch,
                note=note,
                is_repo=repo.is_repo,
                filtered_out=filtered_out,
                # Same reason as `filtered_out`: an empty diff is not always a
                # clean tree.
                untracked_scan_failed=repo.untracked_scan_failed,
                dropped_paths=dropped_paths,
            )
        )

    # Only where staging is meaningful: in a ref/range scope the index says
    # nothing about the reviewed content, and acting on it would reach outside it.
    can_stage = repo.is_repo and options.scope.kind in ("worktree", "staged")
    if can_stage:
        states = get_stage_states(cwd)
        for diff_file in files:
            diff_file.staged = states.get(diff_file.path, "no")

    # Unlike the empty branch above, a failed scan here leaves a review that
    # looks complete while every new file is missing. Say it on the page and in
    # the report.
    scan_warning = (
        "Listing untracked files failed — any new file in this scope is missing from this diff."
        if repo.untracked_scan_failed
        else None
    )
    if scan_warning:
        warn(scan_warning)

    ctx = ReviewContext(
        # The resolved cwd: the stage routes run git in it, and the raw one may
        # be empty.
        payload=HookPayload(
            session_id=payload.session_id,
            timestamp=payload.timestamp,
            cwd=cwd,
            tool_name=payload.tool_name,
            plan=payload.plan,
        ),
        branch=repo.branch,
        files=files,
        is_repo=repo.is_repo,
        can_stage=can_stage,
        mode="diff",
        scope=repo.scope_label,
        note=None if repo.is_repo else "Not a git repository — no diff available.",
        warning=scan_warning,
    )

    server = start_review_server(ctx)
    log(f"review page at {server.url}")
    log(
        f"{len(files)} file(s) changed — "
        f"{'opening browser…' if options.open else 'open it to review'}"
    )
    if options.open:
        open_browser(server.url)

    try:
        # ONLY this one statement is fail-open, and it catches only ServerClosed:
        # once a verdict has arrived, a later error must not be reported as "no
        # review captured" and invert it into an approval.
        try:
            review = server.gate.wait()
        except ServerClosed as err:
            note = f"No review was captured ({err})."
            warn(f"{note} Allowing.")
            return ReviewOutcome(
                summary=ReviewOutcomeSummary(
                    review=None,
                    files=files,
                    scope=repo.scope_label,
                    branch=repo.branch,
                    note=note,
                    interrupted=True,
                    is_repo=repo.is_repo,
                    untracked_scan_failed=repo.untracked_scan_failed,
                    dropped_paths=dropped_paths,
                )
            )

        # Persist first: the archive is what survives an agent that ignores the
        # report.
        save_history(
            review,
            files,
            HistoryMeta(
                cwd=cwd,
                session_id=payload.session_id,
                scope=repo.scope_label,
                branch=repo.branch,
                mode="diff",
                untracked_scan_failed=repo.untracked_scan_failed,
                dropped_paths=dropped_paths,
                enabled=options.history,
                history_dir=options.history_dir,
            ),
        )
        log(
            f"changes requested ({len(review.comments)} comment(s))"
            if review.decision == "request_changes"
            else "approved"
        )
        return ReviewOutcome(
            summary=ReviewOutcomeSummary(
                review=review,
                files=files,
                scope=repo.scope_label,
                branch=repo.branch,
                is_repo=repo.is_repo,
                # Carried even beside a verdict: it covers only the files that
                # got in.
                untracked_scan_failed=repo.untracked_scan_failed,
                dropped_paths=dropped_paths,
            )
        )
    finally:
        server.close()
