"""End-to-end tests for the entry point.

`revgate` owns two mutually exclusive output contracts (annotations on stdout
for `review`, preToolUse JSON for `plan`), so it is exercised as a real
process — the only way to observe exit codes and stream discipline honestly.

Every byte-exact contract is asserted on **bytes**. A string comparison passes
on a build that writes CRLF or cp1252, which is the whole class of fault these
tests exist to catch.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

from revgate.__main__ import main
from tests.helpers.cli import Streamer, launch, run
from tests.helpers.repo import RepoFactory, TempRepo
from tests.helpers.server import get, post

#: The exact bytes a fail-open plan hook owes stdout.
ALLOW = b'{"permissionDecision":"allow"}\n'

SESSION_UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"


@pytest.fixture
def clean_repo(make_repo: RepoFactory) -> TempRepo:
    """A repo with one committed file and no pending changes."""
    return make_repo({"a.txt": "one\n"})


def submit(url: str, body: dict[str, object]) -> None:
    post(f"{url}api/submit", json.dumps(body))


def write_session_plan(home: Path, session_id: str, body: str) -> None:
    """Write a session's plan.md under a sandboxed $COPILOT_HOME."""
    directory = home / "session-state" / session_id
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "plan.md").write_text(body, encoding="utf-8", newline="")


# --- usage -----------------------------------------------------------------


def test_help_prints_every_flag_on_stdout_and_exits_0() -> None:
    result = run(["review", "--help"])
    assert result.code == 0
    assert result.stderr == b""
    for flag in (
        "--staged",
        "--include",
        "--exclude",
        "--plan",
        "--output",
        "--exit-code-on-comments",
        "--history-dir",
        "--no-history",
        "--no-open",
        "--help",
    ):
        assert flag in result.out, f"--help should document {flag}"
    assert "Exit codes:" in result.out
    assert re.search(r"^ {2}10 {2}comments were captured", result.out, re.MULTILINE)


def test_the_help_text_reaches_stdout_as_lf_bytes() -> None:
    """The regression test for the whole Windows CRLF and cp1252 class of fault.

    A string comparison would pass on a build that translated the newlines.
    """
    result = run(["review", "--help"])
    assert b"\r\n" not in result.stdout
    assert result.stdout.startswith(
        "revgate — human-in-the-loop, GitHub-style code review\n".encode()
    )
    assert result.stdout.endswith(b"\n")


def test_an_unknown_flag_is_bad_usage_with_nothing_on_stdout() -> None:
    result = run(["review", "--bogus"])
    assert result.code == 2
    assert result.stdout == b""
    assert "unknown flag: --bogus" in result.err
    assert "revgate review --help" in result.err


def test_an_unresolvable_ref_is_bad_usage_not_a_crash(clean_repo: TempRepo) -> None:
    result = run(["review", "does-not-exist"], cwd=clean_repo.dir)
    assert result.code == 2
    assert result.stdout == b""
    assert "does-not-exist" in result.err


def test_a_mistyped_subcommand_is_never_a_hook_shaped_allow_at_exit_0(
    clean_repo: TempRepo,
) -> None:
    """`revgate reviw` used to fall through to the agentStop hook.

    There "reviw" became a git ref: the ref failed to resolve, the fail-open
    contract wrote a decision to stdout, and the process exited 0. Both skills
    read exit 0 as "approved, nothing to act on", so one dropped letter turned a
    review that never happened into a clean bill of health.
    """
    clean_repo.write("a.txt", "one\ntwo\n")
    result = run(["reviw", "--exit-code-on-comments"], cwd=clean_repo.dir)
    assert result.code == 2, "a typo must be reported, not absorbed by the hook contract"
    assert result.stdout == b"", "nothing may reach stdout — least of all a decision"
    assert "unknown command: reviw" in result.err
    assert "revgate review --help" in result.err


def test_a_fatal_git_failure_is_reported_honestly_never_as_an_approval(
    clean_repo: TempRepo, tmp_path: Path
) -> None:
    """`diff.algorithm` is validated only when a diff actually runs.

    `rev-parse` still succeeds and the failure lands inside collect_diff. There
    is no hook to wedge on this path, and a silent 0 would read as an approval.
    """
    clean_repo.write("a.txt", "one\ntwo\n")
    config = tmp_path / "gitconfig"
    config.write_text("[diff]\n\talgorithm = nonsense\n", encoding="utf-8")

    result = run(
        ["review", "--no-open", "--no-history"],
        cwd=clean_repo.dir,
        env={"GIT_CONFIG_GLOBAL": str(config)},
    )
    assert result.code != 0, "the CLI must not report a git failure as success"
    assert "APPROVED" not in result.out
    assert '"decision"' not in result.out, "the CLI path never writes hook JSON"


def test_a_fatal_error_on_the_hook_path_emits_the_permission_shape_and_exits_0(
    tmp_path: Path,
) -> None:
    """`main()`'s last-resort handler.

    preToolUse fails CLOSED, so a handler that exited non-zero — or wrote
    anything but a PermissionDecision — would deny every tool call for the
    session. The trigger: `plan.md` as a *directory*.
    """
    home = tmp_path / "copilot"
    (home / "session-state" / SESSION_UUID / "plan.md").mkdir(parents=True)

    result = run(
        ["plan"],
        env={"COPILOT_HOME": str(home)},
        stdin=json.dumps(
            {
                "sessionId": SESSION_UUID,
                "toolCalls": [{"id": "1", "name": "exit_plan_mode", "args": "{}"}],
            }
        ),
    )
    assert result.code == 0, "a non-zero exit from preToolUse denies the tool"
    assert result.stdout == ALLOW
    assert '"decision"' not in result.out, "any other JSON shape is unparseable to preToolUse"


def test_path_filters_that_match_nothing_are_reported_not_quietly_approved(
    clean_repo: TempRepo,
) -> None:
    """An -I prefix that matches nothing produces the same empty file list as a clean tree.

    Reported as APPROVED at exit 0 that is a clean bill of health for a diff
    nobody saw, so it takes the NOTHING IN SCOPE / exit-2 path instead — in the
    report itself, because stderr does not reach an agent reading only `-o`.
    """
    clean_repo.write("a.txt", "one\ntwo\n")
    result = run(["review", "--no-open", "--no-history", "-I", "no-such-dir"], cwd=clean_repo.dir)
    assert result.code == 2, "filters that hide the whole diff are bad usage, not an approval"
    assert re.search(r"^# revgate review: NOTHING IN SCOPE$", result.out, re.MULTILINE)
    assert "APPROVED" not in result.out
    assert re.search(r"^filtered-out: 1$", result.out, re.MULTILINE)
    assert "relative to the repository root" in result.out
    assert re.search(r"^scope: working tree vs HEAD \[\+no-such-dir\]$", result.out, re.MULTILINE)
    assert "removed by the path filters" in result.err
    assert "relative to the repository root" in result.err


def test_a_filter_matching_nothing_from_a_subdirectory_still_fails_loudly(
    clean_repo: TempRepo,
) -> None:
    """The prefixes match repo-root-relative paths.

    The cwd-relative spelling an agent invoked from a subdirectory reaches for
    (`-I b.txt` for `pkg/b.txt`) matches nothing, and that must surface as an
    error rather than as a review of an empty diff.
    """
    clean_repo.write("pkg/b.txt", "one\ntwo\n")
    sub = clean_repo.dir / "pkg"

    missed = run(["review", "--no-open", "--no-history", "-I", "b.txt"], cwd=sub)
    assert missed.code == 2
    assert re.search(r"^# revgate review: NOTHING IN SCOPE$", missed.out, re.MULTILINE)

    # The documented root-relative spelling matches from that same cwd, so the
    # diff is found and the review opens instead.
    streams = Streamer(launch(["review", "--no-open", "--no-history", "-I", "pkg"], cwd=sub))
    try:
        streams.wait_for_url()
        assert "1 file(s) changed" in streams.err()
        assert "NOTHING IN SCOPE" not in streams.out()
    finally:
        streams.kill()


# --- nothing to review -----------------------------------------------------


def test_a_clean_tree_exits_0_with_annotations_explaining_why(clean_repo: TempRepo) -> None:
    result = run(["review", "--no-open"], cwd=clean_repo.dir)
    assert result.code == 0
    assert re.search(r"^# revgate review: APPROVED$", result.out, re.MULTILINE)
    assert re.search(r"^files: 0$", result.out, re.MULTILINE)
    assert re.search(r"^comments: 0$", result.out, re.MULTILINE)
    assert "No changes to review" in result.out


def test_exit_code_on_comments_still_exits_0_when_there_is_nothing_to_say(
    clean_repo: TempRepo,
) -> None:
    assert run(["review", "--no-open", "--exit-code-on-comments"], cwd=clean_repo.dir).code == 0


def test_output_sends_annotations_to_the_file_and_leaves_stdout_empty(
    clean_repo: TempRepo, tmp_path: Path
) -> None:
    out = tmp_path / "review.md"
    result = run(["review", "--no-open", "-o", str(out)], cwd=clean_repo.dir)
    assert result.code == 0
    assert result.stdout == b""
    assert "annotations written to" in result.err
    assert re.search(r"^# revgate review: APPROVED$", out.read_text(encoding="utf-8"), re.MULTILINE)


def test_the_output_file_is_written_with_lf_line_endings(
    clean_repo: TempRepo, tmp_path: Path
) -> None:
    """`-o` is a byte contract too: an agent greps the file line by line."""
    out = tmp_path / "review.md"
    run(["review", "--no-open", "-o", str(out)], cwd=clean_repo.dir)
    assert b"\r\n" not in out.read_bytes()


def test_outside_a_git_repository_it_is_bad_usage_not_an_approval(tmp_path: Path) -> None:
    """ "Nothing to review" and "you are in the wrong directory" are not the same report.

    Exit 0 with an APPROVED banner would hand the agent a human sign-off on work
    nobody looked at.
    """
    result = run(["review", "--no-open"], cwd=tmp_path)
    assert result.code == 2
    assert re.search(r"^# revgate review: NO REVIEW CAPTURED$", result.out, re.MULTILINE)
    assert "APPROVED" not in result.out
    assert "Not a git repository" in result.out
    assert re.search(r"not a git repository", result.err, re.IGNORECASE)


def test_help_does_not_launder_a_bad_command_line_into_exit_0() -> None:
    """An agent recovering from a usage error by appending --help must not loop."""
    result = run(["review", "--bogus", "--help"])
    assert result.code == 2
    assert "unknown flag: --bogus" in result.err
    assert "Exit codes:" in result.out, "the requested usage text is still printed"


# --- a full review round trip ----------------------------------------------


def test_a_submitted_request_changes_lands_on_stdout_and_exits_10(
    clean_repo: TempRepo,
) -> None:
    clean_repo.write("a.txt", "one\ntwo\n")
    streams = Streamer(
        launch(
            ["review", "--no-open", "--exit-code-on-comments", "--no-history"],
            cwd=clean_repo.dir,
        )
    )
    try:
        url = streams.wait_for_url()
        submit(
            url,
            {
                "decision": "request_changes",
                "summary": "One nit.",
                "comments": [
                    {
                        "file": "a.txt",
                        "startLine": 2,
                        "endLine": 2,
                        "side": "new",
                        "body": "Drop this line.\nIt is dead.",
                    }
                ],
            },
        )
        result = streams.finish()
    except BaseException:
        streams.kill()
        raise

    assert result.code == 10, "comments captured must signal exit 10"
    assert re.search(r"^# revgate review: REQUEST CHANGES$", result.out, re.MULTILINE)
    assert re.search(r"^comments: 1$", result.out, re.MULTILINE)
    assert re.search(r"^## a\.txt:2 \(\+\)$", result.out, re.MULTILINE)
    # The header carries the branch, as the README and the review skill show it.
    assert re.search(r"^scope: working tree vs HEAD$", result.out, re.MULTILINE)
    assert re.search(r"^branch: main$", result.out, re.MULTILINE)
    # Continuation lines are indented so they can never read as a new record.
    assert re.search(r"^Drop this line\.\n It is dead\.$", result.out, re.MULTILINE)
    # stdout is the annotation contract only — never hook JSON.
    assert '"decision"' not in result.out
    # And it is LF all the way, on every platform.
    assert b"\r\n" not in result.stdout


def test_an_approval_writes_history_under_history_dir_and_exits_0(
    clean_repo: TempRepo, tmp_path: Path
) -> None:
    clean_repo.write("a.txt", "one\ntwo\n")
    history = tmp_path / "hist"

    streams = Streamer(
        launch(
            [
                "review",
                "--no-open",
                "--exit-code-on-comments",
                "--history-dir",
                str(history),
            ],
            cwd=clean_repo.dir,
        )
    )
    try:
        url = streams.wait_for_url()
        submit(
            url,
            {
                "decision": "approve",
                "summary": "Looks good.",
                "comments": [
                    {
                        "file": "a.txt",
                        "startLine": 2,
                        "endLine": 2,
                        "side": "new",
                        "body": "Nice.",
                    }
                ],
            },
        )
        result = streams.finish()
    except BaseException:
        streams.kill()
        raise

    assert result.code == 10, "a comment counts even on an approval"
    assert re.search(r"^# revgate review: APPROVED$", result.out, re.MULTILINE)

    repos = list(history.iterdir())
    assert len(repos) == 1
    saved = list(repos[0].iterdir())
    assert len(saved) == 1
    assert "Nice." in saved[0].read_text(encoding="utf-8")


# --- staging is scoped to the working tree ---------------------------------


def test_a_ref_scope_does_not_offer_staging_but_the_working_tree_scope_does(
    clean_repo: TempRepo,
) -> None:
    """Staging acts on the working tree.

    In a ref review the diff comes from commits, so `git add` would stage
    content that is not in the reviewed diff and `git reset` would drop real
    staged work.
    """
    clean_repo.write("a.txt", "one\ntwo\n")
    clean_repo.git("add", "a.txt")
    clean_repo.git("commit", "-m", "second")
    clean_repo.write("a.txt", "one\ntwo\nthree\n")

    def read(args: list[str]) -> tuple[dict[str, object], int]:
        streams = Streamer(
            launch(["review", *args, "--no-open", "--no-history"], cwd=clean_repo.dir)
        )
        try:
            url = streams.wait_for_url()
            ctx = get(f"{url}api/review").json()
            stage = post(f"{url}api/stage", json.dumps({"file": "a.txt"}))
            return ctx, stage.status
        finally:
            streams.kill()

    ref_ctx, ref_status = read(["HEAD~1"])
    # Present and false, not absent: the review command always computes it,
    # and the page reads it to decide whether to render the toggle at all.
    assert ref_ctx["canStage"] is False, "a ref scope must not advertise staging"
    files = ref_ctx["files"]
    assert isinstance(files, list)
    assert "staged" not in files[0], "no staging state is computed for a ref scope"
    assert ref_status == 409, "the route must refuse even though the UI hides the toggle"

    worktree_ctx, worktree_status = read([])
    assert worktree_ctx["canStage"] is True
    assert worktree_status == 200

    # The `--staged` scope reads the index, which is what the toggle acts on.
    # The worktree read above already staged a.txt, so this scope is non-empty.
    staged_ctx, staged_status = read(["--staged"])
    assert staged_ctx["canStage"] is True, "the staged scope must offer staging"
    assert staged_status == 200


# --- plan mode -------------------------------------------------------------


def test_plan_with_a_file_reviews_the_document_instead_of_the_diff(
    clean_repo: TempRepo,
) -> None:
    clean_repo.write("PLAN.md", "# Plan: ship it\n\nStep one.\n")
    streams = Streamer(
        launch(["review", "--plan", "PLAN.md", "--no-open", "--no-history"], cwd=clean_repo.dir)
    )
    try:
        url = streams.wait_for_url()
        ctx = get(f"{url}api/review").json()
        assert ctx["mode"] == "plan"
        assert ctx["planTitle"] == "Plan: ship it"

        submit(
            url,
            {
                "decision": "approve",
                "summary": "",
                # "Plan" is the synthetic file `plan_to_files` names, and the
                # only path the UI can anchor a plan comment to — so it must
                # survive the submit-side check that comments name a known file.
                "comments": [
                    {
                        "file": "Plan",
                        "startLine": 3,
                        "endLine": 3,
                        "side": "new",
                        "body": "Say how.",
                    }
                ],
            },
        )
        result = streams.finish()
    except BaseException:
        streams.kill()
        raise

    assert result.code == 0
    assert re.search(r"^mode: plan$", result.out, re.MULTILINE)
    assert re.search(r"^## Plan:3 \(\+\)$", result.out, re.MULTILINE)
    assert re.search(r"^Say how\.$", result.out, re.MULTILINE)


def test_plan_with_a_missing_file_is_bad_usage_never_a_silent_diff_review(
    clean_repo: TempRepo,
) -> None:
    """The skill reads exit 0 as "the plan is approved, start implementing".

    A typo'd path that quietly reviewed the working tree instead would hand back
    an approval for a plan nobody ever saw.
    """
    result = run(["review", "--plan", "nope.md", "--no-open"], cwd=clean_repo.dir)
    assert result.code == 2
    assert "could not read plan file nope.md" in result.err
    assert not re.search(r"^# revgate review: APPROVED$", result.out, re.MULTILINE)
    assert not re.search(r"^mode: plan$", result.out, re.MULTILINE)


def test_plan_with_no_file_and_no_env_var_is_bad_usage(clean_repo: TempRepo) -> None:
    result = run(
        ["review", "--plan", "--no-open"],
        cwd=clean_repo.dir,
        env={"REVGATE_PLAN_FILE": ""},
    )
    assert result.code == 2
    assert "no plan text was found" in result.err
    assert "pass a file or set $REVGATE_PLAN_FILE" in result.err
    assert not re.search(r"^# revgate review: APPROVED$", result.out, re.MULTILINE)


def test_plan_with_an_empty_file_is_bad_usage_not_an_approval_of_a_blank_plan(
    clean_repo: TempRepo,
) -> None:
    """An existing-but-empty file is not a plan.

    The agent may have created it before writing to it. Reviewing it would show
    a blank document the reviewer can only approve, and exit 0 tells the skill
    to start implementing.
    """
    clean_repo.write("PLAN.md", "   \n\n")
    result = run(["review", "--plan", "PLAN.md", "--no-open"], cwd=clean_repo.dir)
    assert result.code == 2
    assert "plan file PLAN.md is empty" in result.err
    assert "no plan text was found" in result.err
    assert not re.search(r"^# revgate review: APPROVED$", result.out, re.MULTILINE)
    assert not re.search(r"^mode: plan$", result.out, re.MULTILINE)


@pytest.mark.parametrize("argv", [[], ["--no-open"], ["--plan", "PLAN.md", "--no-open"]])
def test_legacy_agent_stop_invocations_exit_2_with_a_migration_hint(
    argv: list[str], clean_repo: TempRepo
) -> None:
    """These command lines were the agentStop diff gate before it was removed.

    A stale hooks.json still running them must get a loud usage error — never a
    review UI, and never a decision Copilot would read as a completed gate.
    """
    clean_repo.write("PLAN.md", "# Plan: ship it\n")
    payload = json.dumps({"sessionId": "abc", "cwd": str(clean_repo.dir), "stopReason": "end_turn"})
    result = run(argv, cwd=clean_repo.dir, stdin=payload)
    assert result.code == 2, f"revgate {' '.join(argv)} must be bad usage"
    assert result.stdout == b"", "nothing may reach stdout — least of all a decision"
    assert "missing the `review` subcommand" in result.err
    assert "re-run install.ps1" in result.err


def test_the_plan_file_env_var_supplies_the_plan_when_no_path_is_given(
    clean_repo: TempRepo,
) -> None:
    """How the /revgate-plan skill's second documented form works."""
    clean_repo.write("PLAN.md", "# Plan: from the env\n\nStep one.\n")
    streams = Streamer(
        launch(
            ["review", "--plan", "--no-open", "--no-history"],
            cwd=clean_repo.dir,
            env={"REVGATE_PLAN_FILE": str(clean_repo.dir / "PLAN.md")},
        )
    )
    try:
        url = streams.wait_for_url()
        ctx = get(f"{url}api/review").json()
        assert ctx["mode"] == "plan"
        assert ctx["planTitle"] == "Plan: from the env"
        submit(url, {"decision": "approve", "summary": "", "comments": []})
        result = streams.finish()
    except BaseException:
        streams.kill()
        raise

    assert result.code == 0
    assert re.search(r"^mode: plan$", result.out, re.MULTILINE)


def test_the_plan_file_env_var_alone_does_not_turn_a_diff_review_into_a_plan_review(
    clean_repo: TempRepo, tmp_path: Path
) -> None:
    """`resolve_plan` only consults the env var once `--plan` asked for plan mode.

    If that guard inverted, every review would become a plan review for anyone
    who exports the variable — and the actual changes would go unreviewed.
    """
    plan_file = tmp_path / "PLAN.md"
    plan_file.write_text("# Plan: not this one\n", encoding="utf-8")

    result = run(
        ["review", "--no-open"],
        cwd=clean_repo.dir,
        env={"REVGATE_PLAN_FILE": str(plan_file)},
    )
    assert result.code == 0
    assert "No changes to review" in result.out, "the diff review is what should have run"
    assert not re.search(r"^mode: plan$", result.out, re.MULTILINE)
    assert "proposed plan" not in result.err


# --- hook payload robustness -----------------------------------------------


def test_an_unparseable_payload_warns_and_still_allows() -> None:
    result = run(["plan"], stdin="not json at all")
    assert result.code == 0
    assert result.stdout == ALLOW
    assert "could not parse hook payload" in result.err


def test_stdin_that_is_never_closed_still_completes_via_the_read_timeout() -> None:
    """Every other test ends the pipe.

    A parent that does not would otherwise keep this process alive until
    Copilot's own timeout — the hang the read guard exists to prevent.
    """
    process = launch(["plan", "--no-open"])
    streams = Streamer(process)
    # Written but deliberately NOT closed.
    assert process.stdin is not None
    process.stdin.write(b"")
    process.stdin.flush()
    result = streams.finish(deadline=30)
    assert result.code == 0
    assert result.stdout == ALLOW


def test_a_tool_that_is_not_exit_plan_mode_passes_straight_through() -> None:
    result = run(
        ["plan"],
        stdin=json.dumps(
            {
                "sessionId": "abc",
                "toolCalls": [{"id": "1", "name": "shell", "args": '{"command":"ls"}'}],
            }
        ),
    )
    assert result.code == 0
    assert result.stdout == ALLOW


def test_an_unidentifiable_tool_warns_and_allows() -> None:
    result = run(["plan"], stdin=json.dumps({}))
    assert result.code == 0
    assert result.stdout == ALLOW
    assert "no identifiable tool" in result.err


def test_exit_plan_mode_with_no_plan_text_allows_rather_than_gating(tmp_path: Path) -> None:
    result = run(
        ["plan"],
        env={"COPILOT_HOME": str(tmp_path / "copilot")},
        stdin=json.dumps(
            {
                "sessionId": "abc",
                "toolCalls": [{"id": "1", "name": "exit_plan_mode", "args": "{}"}],
            }
        ),
    )
    assert result.code == 0
    assert result.stdout == ALLOW
    assert "no plan text found" in result.err


def test_a_requested_change_becomes_a_deny_carrying_the_feedback(tmp_path: Path) -> None:
    home = tmp_path / "copilot"
    home.mkdir()
    streams = Streamer(
        launch(
            ["plan", "--no-open"],
            env={"COPILOT_HOME": str(home), "REVGATE_HISTORY_DIR": str(home / "history")},
        )
    )
    process = streams.process
    assert process.stdin is not None
    process.stdin.write(
        json.dumps(
            {
                "sessionId": "abc",
                "toolCalls": [
                    {
                        "id": "1",
                        "name": "exit_plan_mode",
                        "args": json.dumps({"plan": "# Plan: ship it\n\nStep one.\n"}),
                    }
                ],
            }
        ).encode()
    )
    process.stdin.close()
    try:
        url = streams.wait_for_url()
        submit(
            url,
            {
                "decision": "request_changes",
                "summary": "Add a rollback step.",
                "comments": [],
            },
        )
        result = streams.finish()
    except BaseException:
        streams.kill()
        raise

    assert result.code == 0, "the plan gate must never exit non-zero — that fails closed"
    decision = json.loads(result.stdout)
    assert decision["permissionDecision"] == "deny"
    assert "Add a rollback step." in decision["permissionDecisionReason"]
    # The decision is one compact line: Copilot parses it whole.
    assert result.stdout.endswith(b"\n")
    assert result.stdout.count(b"\n") == 1


def test_an_approved_plan_allows_the_tool_to_proceed(tmp_path: Path) -> None:
    home = tmp_path / "copilot"
    home.mkdir()
    streams = Streamer(
        launch(
            ["plan", "--no-open"],
            env={"COPILOT_HOME": str(home), "REVGATE_HISTORY_DIR": str(home / "history")},
        )
    )
    process = streams.process
    assert process.stdin is not None
    process.stdin.write(
        json.dumps(
            {
                "sessionId": "abc",
                "toolCalls": [
                    {
                        "id": "1",
                        "name": "exit_plan_mode",
                        "args": json.dumps({"summary": "# Plan\n\nDo it.\n"}),
                    }
                ],
            }
        ).encode()
    )
    process.stdin.close()
    try:
        url = streams.wait_for_url()
        submit(url, {"decision": "approve", "summary": "", "comments": []})
        result = streams.finish()
    except BaseException:
        streams.kill()
        raise

    assert result.code == 0
    assert result.stdout == ALLOW


def test_a_non_plan_tools_summary_argument_is_never_mistaken_for_a_plan() -> None:
    result = run(
        ["plan"],
        stdin=json.dumps(
            {
                "sessionId": "abc",
                "toolCalls": [
                    {
                        "id": "1",
                        "name": "write_file",
                        "args": json.dumps({"summary": "# Not a plan\n"}),
                    }
                ],
            }
        ),
    )
    assert result.code == 0
    assert result.stdout == ALLOW


def test_vs_codes_snake_case_payload_is_understood_too(tmp_path: Path) -> None:
    """tool_name + tool_input, no toolCalls array.

    If it silently stopped working the gate would just never fire, and every
    plan would sail through unreviewed.
    """
    result = run(
        ["plan"],
        env={"COPILOT_HOME": str(tmp_path / "no-such-home")},
        stdin=json.dumps(
            {"session_id": "abc", "tool_name": "exit_plan_mode", "tool_input": {"plan": ""}}
        ),
    )
    assert result.code == 0
    assert result.stdout == ALLOW
    # Identified as the plan tool, then allowed only because the plan was empty.
    assert "no plan text found" in result.err
    assert "no identifiable tool" not in result.err


def test_tool_args_given_as_an_object_not_a_json_string(tmp_path: Path) -> None:
    home = tmp_path / "copilot"
    home.mkdir()
    streams = Streamer(
        launch(["plan", "--no-open", "--no-history"], env={"COPILOT_HOME": str(home)})
    )
    process = streams.process
    assert process.stdin is not None
    process.stdin.write(
        json.dumps(
            {
                "sessionId": "abc",
                "toolCalls": [
                    {
                        "id": "1",
                        "name": "exit_plan_mode",
                        "args": {"plan": "# Plan: object args\n"},
                    }
                ],
            }
        ).encode()
    )
    process.stdin.close()
    try:
        url = streams.wait_for_url()
        ctx = get(f"{url}api/review").json()
        assert ctx["mode"] == "plan"
        assert ctx["planTitle"] == "Plan: object args"
        submit(url, {"decision": "approve", "summary": "", "comments": []})
        result = streams.finish()
    except BaseException:
        streams.kill()
        raise

    assert result.code == 0
    assert result.stdout == ALLOW


def test_no_history_is_honoured_after_the_subcommand(tmp_path: Path) -> None:
    """The hook is one command line in hooks.json.

    A flag there is the only way to opt out of history on the plan gate.
    """
    home = tmp_path / "copilot"
    home.mkdir()
    history = home / "history"
    streams = Streamer(
        launch(
            ["plan", "--no-open", "--no-history"],
            env={"COPILOT_HOME": str(home), "REVGATE_HISTORY_DIR": str(history)},
        )
    )
    process = streams.process
    assert process.stdin is not None
    process.stdin.write(
        json.dumps(
            {
                "sessionId": "abc",
                "toolCalls": [
                    {
                        "id": "1",
                        "name": "exit_plan_mode",
                        "args": json.dumps({"plan": "# Plan: ship it\n"}),
                    }
                ],
            }
        ).encode()
    )
    process.stdin.close()
    try:
        url = streams.wait_for_url()
        submit(url, {"decision": "request_changes", "summary": "No.", "comments": []})
        streams.finish()
    except BaseException:
        streams.kill()
        raise

    assert not history.exists(), "--no-history was ignored on the plan gate"


def test_the_sessions_plan_md_beats_the_condensed_inline_plan(tmp_path: Path) -> None:
    """In production Copilot passes a UUID and writes the FULL plan to disk.

    If that lookup broke the reviewer would silently approve the condensed
    summary instead.
    """
    home = tmp_path / "copilot"
    write_session_plan(home, SESSION_UUID, "# Plan: the full one from disk\n\nStep one.\n")

    streams = Streamer(
        launch(["plan", "--no-open", "--no-history"], env={"COPILOT_HOME": str(home)})
    )
    process = streams.process
    assert process.stdin is not None
    process.stdin.write(
        json.dumps(
            {
                "sessionId": SESSION_UUID,
                "toolCalls": [
                    {
                        "id": "1",
                        "name": "exit_plan_mode",
                        "args": json.dumps({"plan": "# Plan: the condensed inline one\n"}),
                    }
                ],
            }
        ).encode()
    )
    process.stdin.close()
    try:
        url = streams.wait_for_url()
        assert get(f"{url}api/review").json()["planTitle"] == "Plan: the full one from disk"
        submit(url, {"decision": "approve", "summary": "", "comments": []})
        result = streams.finish()
    except BaseException:
        streams.kill()
        raise

    assert result.code == 0
    assert result.stdout == ALLOW


def test_with_no_session_id_the_inline_plan_beats_another_sessions_plan_md(
    tmp_path: Path,
) -> None:
    """A payload that names no session drops the disk lookup into its fallback.

    That fallback is "newest plan.md anywhere", including sessions for other
    repositories. The plan this very tool call carries is the only one we know
    belongs to the turn being gated, so it has to win.
    """
    home = tmp_path / "copilot"
    write_session_plan(home, SESSION_UUID, "# Plan: someone else's\n")

    streams = Streamer(
        launch(["plan", "--no-open", "--no-history"], env={"COPILOT_HOME": str(home)})
    )
    process = streams.process
    assert process.stdin is not None
    process.stdin.write(
        json.dumps(
            {
                "toolCalls": [
                    {
                        "id": "1",
                        "name": "exit_plan_mode",
                        "args": json.dumps({"plan": "# Plan: this turn's\n"}),
                    }
                ]
            }
        ).encode()
    )
    process.stdin.close()
    try:
        url = streams.wait_for_url()
        assert get(f"{url}api/review").json()["planTitle"] == "Plan: this turn's"
        submit(url, {"decision": "approve", "summary": "", "comments": []})
        streams.finish()
    except BaseException:
        streams.kill()
        raise


def test_a_gated_plan_is_archived_under_the_plans_own_title(tmp_path: Path) -> None:
    home = tmp_path / "copilot"
    home.mkdir()
    history = home / "history"
    streams = Streamer(
        launch(
            ["plan", "--no-open"],
            env={"COPILOT_HOME": str(home), "REVGATE_HISTORY_DIR": str(history)},
        )
    )
    process = streams.process
    assert process.stdin is not None
    process.stdin.write(
        json.dumps(
            {
                "sessionId": "abc",
                "toolCalls": [
                    {
                        "id": "1",
                        "name": "exit_plan_mode",
                        "args": json.dumps({"plan": "# Plan: add rate limiting\n\nStep one.\n"}),
                    }
                ],
            }
        ).encode()
    )
    process.stdin.close()
    try:
        url = streams.wait_for_url()
        submit(url, {"decision": "request_changes", "summary": "Add a rollback.", "comments": []})
        streams.finish()
    except BaseException:
        streams.kill()
        raise

    # History exists so a review survives a hook timeout — the plan gate is
    # where that matters most, and its scope label is built nowhere else.
    repos = list(history.iterdir())
    assert len(repos) == 1
    saved = list(repos[0].iterdir())
    assert len(saved) == 1
    content = saved[0].read_text(encoding="utf-8")
    assert re.search(r"^mode: plan$", content, re.MULTILINE)
    assert re.search(r'^scope: "plan: Plan: add rate limiting"$', content, re.MULTILINE)


def test_a_top_level_plan_field_is_accepted_as_the_inline_plan(tmp_path: Path) -> None:
    """`HookPayload.plan` is a documented input shape that nothing else exercises."""
    home = tmp_path / "copilot"
    home.mkdir()
    streams = Streamer(
        launch(["plan", "--no-open", "--no-history"], env={"COPILOT_HOME": str(home)})
    )
    process = streams.process
    assert process.stdin is not None
    process.stdin.write(
        json.dumps(
            {
                "sessionId": "abc",
                "toolName": "exit_plan_mode",
                "plan": "# Plan: from the payload\n\nStep one.\n",
            }
        ).encode()
    )
    process.stdin.close()
    try:
        url = streams.wait_for_url()
        ctx = get(f"{url}api/review").json()
        assert ctx["mode"] == "plan"
        assert ctx["planTitle"] == "Plan: from the payload"
        submit(url, {"decision": "approve", "summary": "", "comments": []})
        result = streams.finish()
    except BaseException:
        streams.kill()
        raise

    assert result.code == 0
    assert result.stdout == ALLOW


def test_a_payload_with_a_leading_utf8_bom_is_still_parsed() -> None:
    """Some shells and pipes prepend one.

    Without the strip the whole payload is lost — and with it the tool name,
    which turns a real payload into a warned pass-through.
    """
    result = run(
        ["plan"],
        stdin="﻿"
        + json.dumps(
            {
                "sessionId": "bom",
                "toolCalls": [{"id": "1", "name": "shell", "args": '{"command":"ls"}'}],
            }
        ),
    )
    assert result.code == 0
    assert result.stdout == ALLOW
    assert "could not parse hook payload" not in result.err
    assert "no identifiable tool" not in result.err


def test_an_unparseable_args_string_allows_instead_of_crashing(tmp_path: Path) -> None:
    """toolCalls[].args is a JSON *string* in Copilot's payload.

    A malformed one must degrade to "no plan text" — this hook fails closed on a
    non-zero exit, so a raise here would deny the tool.
    """
    result = run(
        ["plan"],
        env={"COPILOT_HOME": str(tmp_path / "no-such-home")},
        stdin=json.dumps(
            {
                "sessionId": "abc",
                "toolCalls": [{"id": "1", "name": "exit_plan_mode", "args": "{not json"}],
            }
        ),
    )
    assert result.code == 0
    assert result.stdout == ALLOW
    assert "no plan text found" in result.err


# --- --output failures -----------------------------------------------------


def test_an_unwritable_output_destination_falls_back_to_stdout_not_to_exit_1(
    clean_repo: TempRepo,
) -> None:
    """The human has already reviewed by the time we write.

    Letting the write fail would surface as exit 1, which both skills read as
    "no verdict was captured": a completed review reported as one that never
    happened, with the annotations nowhere at all.
    """
    result = run(
        ["review", "--no-open", "-o", str(clean_repo.dir / "nope" / "out.md")],
        cwd=clean_repo.dir,
    )
    assert result.code == 0, "a delivered report keeps the verdict's own exit code"
    assert re.search(r"^# revgate review: APPROVED$", result.out, re.MULTILINE)
    assert "could not write" in result.err
    assert "writing the annotations to stdout instead" in result.err


# --- a failed untracked scan, end to end -----------------------------------


@pytest.fixture
def git_shim(tmp_path: Path) -> Path:
    """A PATH shim that fails `git ls-files` and delegates everything else.

    The only way to reach collect_diff's untracked-scan catch from outside: git
    itself tolerates a broken excludesFile, and every in-process test of the
    flag has to hand it in by construction. POSIX-only — on Windows a `.cmd`
    shim would take down every git call, not just the scan.
    """
    # Read into a plain `str` so the checker does not narrow the rest of this
    # fixture away on whichever platform it happens to be running on.
    platform: str = sys.platform
    if platform == "win32":
        pytest.skip("the git PATH shim needs a POSIX shell script")
    real = shutil.which("git")
    assert real, "git is required for the suite"
    directory = tmp_path / "gitshim"
    directory.mkdir()
    script = directory / "git"
    script.write_text(
        "#!/bin/sh\n"
        'for a in "$@"; do\n'
        '  if [ "$a" = "ls-files" ]; then\n'
        '    echo "fatal: injected ls-files failure" >&2\n'
        "    exit 128\n"
        "  fi\n"
        "done\n"
        f'exec "{real}" "$@"\n',
        encoding="utf-8",
        newline="",
    )
    script.chmod(0o755)
    return directory


def test_a_failed_untracked_scan_over_an_empty_diff_is_scan_failed_and_exit_2(
    clean_repo: TempRepo, git_shim: Path
) -> None:
    """The dangerous turn: its whole output is new files.

    The tracked diff is empty, and a swallowed scan failure reads as "nothing to
    review, approve".
    """
    clean_repo.write("brand-new.txt", "fresh\n")
    result = run(
        ["review", "--no-open", "--no-history"],
        cwd=clean_repo.dir,
        env={"PATH": f"{git_shim}{os.pathsep}{os.environ.get('PATH', '')}"},
    )
    assert result.code == 2, "an empty diff the scan could not fill must not exit 0"
    assert re.search(r"^# revgate review: SCAN FAILED$", result.out, re.MULTILINE)
    assert re.search(r"^untracked-scan: failed$", result.out, re.MULTILINE)
    assert "APPROVED" not in result.out
    assert "could not list untracked files" in result.err


def test_a_verdict_over_a_diff_whose_scan_failed_carries_the_untracked_scan_line(
    clean_repo: TempRepo, git_shim: Path
) -> None:
    """A tracked change keeps the UI opening and the human approves what they see.

    The report still has to say the new files never reached the diff.
    """
    clean_repo.write("a.txt", "one\ntwo\n")
    streams = Streamer(
        launch(
            ["review", "--no-open", "--no-history"],
            cwd=clean_repo.dir,
            env={"PATH": f"{git_shim}{os.pathsep}{os.environ.get('PATH', '')}"},
        )
    )
    try:
        url = streams.wait_for_url()
        submit(url, {"decision": "approve", "summary": "", "comments": []})
        result = streams.finish()
    except BaseException:
        streams.kill()
        raise

    assert result.code == 0
    assert re.search(r"^# revgate review: APPROVED$", result.out, re.MULTILINE)
    assert re.search(r"^untracked-scan: failed$", result.out, re.MULTILINE)


# --- a missing browser opener ----------------------------------------------


@pytest.mark.skipif(sys.platform == "win32", reason="Windows resolves cmd.exe outside PATH")
def test_a_missing_browser_opener_degrades_to_a_warning_not_a_crash(
    tmp_path: Path,
) -> None:
    """A missing opener must not take the process down.

    On the hook paths a crash there fails CLOSED. An empty PATH makes the spawn
    fail exactly that way; note the deliberate absence of --no-open.
    """
    work = tmp_path / "work"
    work.mkdir()
    (work / "PLAN.md").write_text("# Plan: open sesame\n\nStep one.\n", encoding="utf-8")
    empty_path = tmp_path / "empty"
    empty_path.mkdir()

    streams = Streamer(
        launch(
            ["review", "--plan", "PLAN.md", "--no-history"],
            cwd=work,
            env={"PATH": str(empty_path)},
        )
    )
    try:
        url = streams.wait_for_url()
        deadline = time.monotonic() + 10
        while "could not auto-open browser" not in streams.err():
            if time.monotonic() > deadline:
                raise AssertionError(f"no opener warning appeared; stderr:\n{streams.err()}")
            time.sleep(0.05)
        submit(url, {"decision": "approve", "summary": "", "comments": []})
        result = streams.finish()
    except BaseException:
        streams.kill()
        raise

    assert result.code == 0
    assert re.search(r"^mode: plan$", result.out, re.MULTILINE)


# --- the installed console script ------------------------------------------


def test_the_module_and_the_console_script_agree() -> None:
    """`[project.scripts]` points at `revgate.__main__:main`.

    A console script that resolved to something else would ship a binary the
    hook template names but that behaves differently from the tests.
    """
    assert callable(main)
    module = run(["review", "--help"])
    assert module.code == 0
    assert module.stdout.startswith(b"revgate")


def test_the_entry_point_is_importable_without_running_anything(
    tmp_path: Path,
) -> None:
    """Importing the module must not run `main()`.

    That is what lets every layer below be tested in-process.
    """
    probe = subprocess.run(
        [sys.executable, "-c", "import revgate.__main__; print('imported')"],
        capture_output=True,
        check=True,
        cwd=tmp_path,
    )
    assert probe.stdout.strip() == b"imported"
    assert b"permissionDecision" not in probe.stdout
