"""The review server: static files, the two guards, the API routes, and shutdown."""

import concurrent.futures
import json
import re
import socket
import subprocess
from pathlib import Path

import pytest

from revgate.review.annotations import render_annotations
from revgate.review.feedback import build_decision
from revgate.server.app import PUBLIC_DIR, start_review_server
from revgate.server.wsgi import ServerClosed
from revgate.shared.types import HookPayload
from revgate.store.palettes import BUILTIN_THEMES, PALETTE_KEYS
from tests.helpers.repo import RepoFactory
from tests.helpers.server import (
    context,
    get,
    http10_get,
    make_file,
    port_of,
    post,
    post_with_origin,
    raw_get,
    serve,
)

# --- static files ----------------------------------------------------------


def test_the_root_serves_the_review_ui() -> None:
    with serve() as server:
        assert re.match(r"^http://127\.0\.0\.1:\d+/$", server.url)
        res = get(server.url)
        assert res.status == 200
        assert res.header("content-type") == "text/html; charset=utf-8"
        assert re.search(r"<html", res.text, re.IGNORECASE)


@pytest.mark.parametrize(
    ("name", "content_type"),
    [
        ("app.css", "text/css; charset=utf-8"),
        ("app.js", "text/javascript; charset=utf-8"),
        # The stylesheet asks for this one by absolute path; a wrong type is a
        # font the browser refuses and a page that falls back to a system face.
        ("fonts/jetbrains-mono-latin-400-normal.woff2", "font/woff2"),
    ],
)
def test_the_split_out_assets_are_served_typed(name: str, content_type: str) -> None:
    """A wrong MIME type is a stylesheet parsed as text and a script that never runs."""
    with serve() as server:
        res = get(f"{server.url}{name}")
        assert res.status == 200, name
        assert res.header("content-type") == content_type, name
        assert len(res.body) > 0, f"{name} is empty"


def test_public_dir_resolves_inside_the_installed_package() -> None:
    """Getting this wrong serves a 404 for every asset in an installed build.

    That is a blank review page and a gate the reviewer cannot resolve.
    """
    assert (PUBLIC_DIR / "index.html").is_file()
    assert (PUBLIC_DIR / "app.css").is_file()
    assert (PUBLIC_DIR / "app.js").is_file()


def test_every_response_refuses_to_be_framed() -> None:
    """The Origin guard rejects a cross-origin POST but cannot see a *click*.

    A page that brute-forced the port could frame this UI, float its own content
    over Approve, and the resulting submission is genuinely same-origin — so
    both guards pass and a forged approval resolves the gate.
    """
    with serve() as server:
        for url in (server.url, f"{server.url}api/review", f"{server.url}nope.css"):
            res = get(url)
            assert res.header("x-frame-options") == "DENY", url
            assert "frame-ancestors 'none'" in (res.header("content-security-policy") or ""), url


def test_an_unknown_path_is_a_404_not_a_crash() -> None:
    with serve() as server:
        res = get(f"{server.url}nope.css")
        assert res.status == 404
        assert res.text == "not found"


@pytest.mark.parametrize(
    "attempt", ["../pyproject.toml", "..%2fpyproject.toml", "%2e%2e/pyproject.toml"]
)
def test_a_path_traversal_never_reaches_outside_public(attempt: str) -> None:
    with serve() as server:
        res = get(f"{server.url}{attempt}")
        assert res.status != 200, f"{attempt} must not be served"
        assert "[project]" not in res.text


# --- GET /api/review -------------------------------------------------------


def test_api_review_returns_the_review_context_verbatim() -> None:
    ctx = context(scope="main..feature", branch="feature", is_repo=True)
    with serve(ctx) as server:
        res = get(f"{server.url}api/review")
        assert res.status == 200
        body = res.json()
        assert body["mode"] == "diff"
        assert body["scope"] == "main..feature"
        assert body["branch"] == "feature"
        assert len(body["files"]) == 1
        assert body["files"][0]["path"] == "src/app.ts"


def test_a_warning_reaches_the_page() -> None:
    """The reviewer is looking at the page, not at the caller's stderr.

    A diff that silently omits the turn's new files still looks complete, so the
    reason has to travel with the context the page renders.
    """
    warning = "Listing untracked files failed — any new file in this scope is missing."
    with serve(context(warning=warning)) as server:
        assert get(f"{server.url}api/review").json()["warning"] == warning

    with serve() as clean:
        # Absent, not null: the page tells the two apart.
        assert "warning" not in get(f"{clean.url}api/review").json()


def test_a_plan_review_reports_its_title() -> None:
    with serve(context(mode="plan", plan_title="Add rate limiting")) as server:
        body = get(f"{server.url}api/review").json()
        assert body["mode"] == "plan"
        assert body["planTitle"] == "Add rate limiting"


def test_the_context_is_camel_case_on_the_wire() -> None:
    """The page reads `isRepo`, `canStage` and `planTitle`, not their snake_case names."""
    with serve(context(is_repo=True, can_stage=True)) as server:
        body = get(f"{server.url}api/review").json()
        assert body["isRepo"] is True
        assert body["canStage"] is True
        assert "is_repo" not in body


def test_an_absent_optional_is_absent_not_null() -> None:
    with serve() as server:
        body = get(f"{server.url}api/review").json()
        assert "canStage" not in body
        assert "planTitle" not in body
        assert "scope" not in body


# --- themes ----------------------------------------------------------------


def test_api_themes_returns_every_palette_in_one_response() -> None:
    """One response, not one per theme.

    The page applies a switch from what it already holds, so picking a theme
    costs no round trip and cannot half-fail.
    """
    with serve() as server:
        res = get(f"{server.url}api/themes")
        assert res.status == 200
        body = res.json()
        assert body["selected"] == "system", "a fresh config dir means a fresh install"
        assert len(body["themes"]) == 5
        assert [t["id"] for t in body["themes"]] == [t.id for t in BUILTIN_THEMES]
        for theme in body["themes"]:
            assert theme["type"] in ("dark", "light"), f"{theme['id']} has no usable type"
            # The full colour map has to survive JSON, or a switch leaves the
            # page holding a theme it cannot actually paint.
            assert sorted(theme["colors"]) == sorted(PALETTE_KEYS), theme["id"]


def test_a_theme_choice_reaches_disk_and_the_next_get_reports_it(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The whole point of the feature.

    The server binds a random port, so the browser is a new origin every run and
    only a file on disk can remember.
    """
    config = tmp_path / "cfg"
    config.mkdir()
    monkeypatch.setenv("REVGATE_CONFIG_DIR", str(config))
    with serve() as server:
        res = post(f"{server.url}api/theme", json.dumps({"id": "dracula"}))
        assert res.status == 200
        assert res.json() == {"ok": True}

        on_disk = json.loads((config / "config.json").read_text(encoding="utf-8"))
        assert on_disk == {"theme": "dracula"}

        assert get(f"{server.url}api/themes").json()["selected"] == "dracula"


def test_system_is_a_real_id_not_a_400(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """It is the default and a first-class member of the id set.

    A user who picks it back after trying a built-in must be able to save that.
    """
    config = tmp_path / "cfg"
    config.mkdir()
    monkeypatch.setenv("REVGATE_CONFIG_DIR", str(config))
    with serve() as server:
        post(f"{server.url}api/theme", json.dumps({"id": "monokai"}))
        res = post(f"{server.url}api/theme", json.dumps({"id": "system"}))
        assert res.status == 200
        assert res.json() == {"ok": True}

        assert json.loads((config / "config.json").read_text(encoding="utf-8")) == {
            "theme": "system"
        }
        assert get(f"{server.url}api/themes").json()["selected"] == "system"


@pytest.mark.parametrize(
    "body",
    [
        json.dumps({"id": "solarized-dark"}),
        json.dumps({"id": ""}),
        json.dumps({"id": 7}),
        json.dumps({}),
        "null",
    ],
)
def test_an_unknown_theme_id_is_a_400_and_nothing_is_written(
    body: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Saving one would not break the page — the read path falls back to `system`.

    Which is exactly why it has to be refused here: the user would otherwise be
    handed a theme they never picked, with no error anywhere they can see.
    """
    config = tmp_path / "cfg"
    config.mkdir()
    monkeypatch.setenv("REVGATE_CONFIG_DIR", str(config))
    with serve() as server:
        res = post(f"{server.url}api/theme", body)
        assert res.status == 400, f"expected 400 for {body}"
        assert res.json() == {"error": "unknown theme"}
    assert list(config.iterdir()) == [], "a refused id must not touch the config"


def test_a_theme_write_that_cannot_land_is_still_a_200(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    """Deliberate: the page has already repainted.

    Answering an error here would have it undo a change the user can plainly
    see. The failure goes to stderr and no further — a cosmetic subsystem may
    not fight the gate.
    """
    blocker = tmp_path / "blocker"
    blocker.write_text("not a directory", encoding="utf-8")
    monkeypatch.setenv("REVGATE_CONFIG_DIR", str(blocker / "revgate"))
    with serve() as server:
        res = post(f"{server.url}api/theme", json.dumps({"id": "dracula"}))
        assert res.status == 200
        assert res.json() == {"ok": True}
        assert "could not save theme" in capfd.readouterr().err

        # And the next load degrades to system rather than reporting the failure.
        assert get(f"{server.url}api/themes").json()["selected"] == "system"


def test_malformed_theme_json_is_a_400(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    config = tmp_path / "cfg"
    config.mkdir()
    monkeypatch.setenv("REVGATE_CONFIG_DIR", str(config))
    with serve() as server:
        res = post(f"{server.url}api/theme", "{not json")
        assert res.status == 400
        assert res.json() == {"error": "invalid JSON"}
    assert list(config.iterdir()) == []


def test_a_cross_origin_theme_write_is_rejected_by_the_blanket_guard(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The route adds no guard of its own.

    It relies on the Origin check that covers every POST. If that check ever
    grows a per-route allow-list, this fails rather than leaving a page on any
    origin able to rewrite the config.
    """
    config = tmp_path / "cfg"
    config.mkdir()
    monkeypatch.setenv("REVGATE_CONFIG_DIR", str(config))
    with serve() as server:
        res = post_with_origin(
            f"{server.url}api/theme", json.dumps({"id": "dracula"}), "https://evil.example"
        )
        assert res.status == 403
        assert res.json() == {"error": "cross-origin request rejected"}
    assert list(config.iterdir()) == []


def test_api_themes_is_behind_the_same_host_guard_as_the_diff() -> None:
    """Method-agnostic and above the routing table, so a route added later cannot miss it."""
    with serve() as server:
        port = port_of(server.url)
        rejected = raw_get(port, "/api/themes", f"evil.example:{port}")
        assert rejected.status == 403
        assert rejected.json() == {"error": "unexpected host"}

        assert raw_get(port, "/api/themes", f"127.0.0.1:{port}").status == 200


# --- POST /api/submit ------------------------------------------------------


def test_submit_resolves_the_gate_with_the_review() -> None:
    with serve() as server:
        res = post(
            f"{server.url}api/submit",
            json.dumps(
                {
                    "decision": "request_changes",
                    "summary": "Needs work.",
                    "comments": [
                        {
                            "file": "src/app.ts",
                            "startLine": 2,
                            "endLine": 2,
                            "side": "new",
                            "body": "Use const.",
                        }
                    ],
                }
            ),
        )
        assert res.status == 200
        assert res.json() == {"ok": True}

        review = server.gate.wait()
        assert review.decision == "request_changes"
        assert len(review.comments) == 1
        assert review.comments[0].body == "Use const."


def test_malformed_submit_json_is_a_400_and_leaves_the_review_pending() -> None:
    with serve() as server:
        res = post(f"{server.url}api/submit", "{not json")
        assert res.status == 400
        assert res.json() == {"error": "invalid JSON"}
        # Still waiting: a bad request must not resolve the gate.
        assert not server.gate.settled


@pytest.mark.parametrize(
    "body",
    ["null", '"approve"', "[]", json.dumps({}), json.dumps({"decision": "maybe"})],
)
def test_a_body_that_is_not_a_review_is_a_400_and_leaves_the_gate_pending(body: str) -> None:
    """A dropped verdict must never resolve as "allow".

    That inverts a request-changes into an approval, silently.
    """
    with serve() as server:
        res = post(f"{server.url}api/submit", body)
        assert res.status == 400, f"expected 400 for {body}"
        assert not server.gate.settled, f"{body} resolved the gate"


def test_request_changes_with_nothing_else_still_reads_as_request_changes() -> None:
    with serve() as server:
        res = post(f"{server.url}api/submit", json.dumps({"decision": "request_changes"}))
        assert res.status == 200
        review = server.gate.wait()
        assert review.decision == "request_changes"
        assert review.comments == []


def test_the_body_reaches_the_normalizer_not_the_caller_raw() -> None:
    """One case here is enough to prove the route calls the normalizer at all.

    Rather than resolving the gate with whatever was posted.
    """
    with serve() as server:
        post(
            f"{server.url}api/submit",
            json.dumps({"decision": "request_changes", "comments": [{"file": "src/app.ts"}]}),
        )
        review = server.gate.wait()
        assert review.decision == "request_changes"
        assert len(review.comments) == 1
        comment = review.comments[0]
        assert comment.file == "src/app.ts"
        # The file-level sentinel the annotation renderer understands.
        assert comment.start_line == 0
        assert comment.end_line == 0
        assert comment.side == "new"
        assert comment.body == ""
        # The whole point: rendering it must not raise.
        render_annotations(review, [])
        assert build_decision(review, []).decision == "block"


def test_the_file_set_the_normalizer_filters_against_is_this_reviews() -> None:
    """The route supplies `known`.

    If it ever passed the wrong set, a comment on a file nobody reviewed would
    reach the agent as a directive.
    """
    with serve() as server:
        res = post(
            f"{server.url}api/submit",
            json.dumps(
                {
                    "decision": "request_changes",
                    "summary": "s",
                    "comments": [
                        {
                            "file": "src/app.ts",
                            "startLine": 1,
                            "endLine": 1,
                            "side": "new",
                            "body": "real",
                        },
                        {
                            "file": "src/other.ts",
                            "startLine": 1,
                            "endLine": 1,
                            "side": "new",
                            "body": "not in the review",
                        },
                    ],
                }
            ),
        )
        assert res.status == 200, "the reviewer's real verdict still lands"

        review = server.gate.wait()
        assert len(review.comments) == 1
        assert review.comments[0].file == "src/app.ts"


# --- cross-origin ----------------------------------------------------------


def test_a_cross_origin_submission_is_rejected_and_leaves_the_gate_pending() -> None:
    """The random loopback port is obscurity, not a boundary.

    A page the user has open could brute-force it and forge an approval.
    """
    with serve() as server:
        res = post_with_origin(
            f"{server.url}api/submit",
            json.dumps({"decision": "approve", "summary": "", "comments": []}),
            "https://evil.example",
        )
        assert res.status == 403
        assert res.json() == {"error": "cross-origin request rejected"}
        assert not server.gate.settled


def test_a_submission_with_no_origin_at_all_is_rejected_not_waved_through() -> None:
    """A cross-site form POST needs no Origin to reach us.

    It shapes its body into valid JSON via the field name and carries the
    genuine loopback Host, so the Host guard cannot see it. Treating a missing
    Origin the way a missing Host is treated would forge a human approval.
    """
    with serve() as server:
        res = post_with_origin(
            f"{server.url}api/submit",
            json.dumps({"decision": "approve", "summary": "", "comments": []}),
            None,
        )
        assert res.status == 403
        assert res.json() == {"error": "cross-origin request rejected"}
        assert not server.gate.settled


def test_another_loopback_port_is_still_cross_origin() -> None:
    with serve() as server:
        port = port_of(server.url)
        res = post_with_origin(
            f"{server.url}api/stage",
            json.dumps({"file": "a.txt"}),
            f"http://127.0.0.1:{port + 1}",
        )
        assert res.status == 403


@pytest.mark.parametrize(
    "host_template", ["evil.example:{port}", "attacker.test:{port}", "127.0.0.1:1"]
)
def test_a_request_addressed_to_a_rebound_hostname_is_rejected(host_template: str) -> None:
    """DNS rebinding makes an attacker's page same-origin with this listener.

    The Origin check never fires on a GET — but the Host header still carries
    the attacker's hostname, and /api/review returns the whole diff.
    """
    with serve(context(scope="main..feature")) as server:
        port = port_of(server.url)
        res = raw_get(port, "/api/review", host_template.format(port=port))
        assert res.status == 403, f"host must be rejected: {host_template}"
        assert res.json() == {"error": "unexpected host"}
        assert "main..feature" not in res.text, "the diff must not leak in the error"


def test_our_own_host_still_reads_the_diff() -> None:
    with serve(context(scope="main..feature")) as server:
        port = port_of(server.url)
        ok = raw_get(port, "/api/review", f"127.0.0.1:{port}")
        assert ok.status == 200
        assert "main..feature" in ok.text


@pytest.mark.parametrize("host_template", ["127.0.0.1:{port}", "localhost:{port}", "[::1]:{port}"])
def test_every_loopback_spelling_of_our_own_authority_is_accepted(host_template: str) -> None:
    """`::1` is what a browser sends when localhost resolves to IPv6 first.

    Losing a spelling locks the reviewer out of the only page that can resolve
    the gate, and the agent blocks until the hook times out.
    """
    with serve(context(scope="main..feature")) as server:
        port = port_of(server.url)
        res = raw_get(port, "/api/review", host_template.format(port=port))
        assert res.status == 200, f"host must be accepted: {host_template}"


def test_an_http_1_0_request_with_no_host_is_waved_through() -> None:
    """There is no hostname for a rebinding attack to smuggle in.

    Unlike a missing Origin on a POST, which a cross-site form can produce and
    which is therefore refused.
    """
    with serve(context(scope="main..feature")) as server:
        bare = http10_get(port_of(server.url), "/api/review")
        assert bare.status == 200, "an absent Host must not be rejected"
        assert "main..feature" in bare.text


@pytest.mark.parametrize("hostname", ["127.0.0.1", "localhost"])
def test_our_own_uis_origin_is_accepted(hostname: str) -> None:
    with serve() as server:
        origin = f"http://{hostname}:{port_of(server.url)}"
        res = post_with_origin(
            f"{server.url}api/submit",
            json.dumps({"decision": "approve", "summary": "", "comments": []}),
            origin,
        )
        assert res.status == 200, f"{origin} must be accepted"
        assert server.gate.wait().decision == "approve"


# --- POST /api/stage and /api/unstage --------------------------------------


@pytest.mark.parametrize("route", ["api/stage", "api/unstage"])
def test_staging_outside_a_repository_is_a_409(route: str) -> None:
    with serve(context(is_repo=False)) as server:
        res = post(f"{server.url}{route}", json.dumps({"file": "src/app.ts"}))
        assert res.status == 409
        assert res.json() == {"error": "not a git repository"}


def test_a_scope_where_staging_does_not_apply_is_a_409_with_no_git_side_effect(
    make_repo: RepoFactory,
) -> None:
    """A ref/range review shows committed content.

    Staging acts on the working tree, so `git add` here would stage a change
    that is not in the reviewed diff, and `git reset` would drop real staged work.
    """
    repo = make_repo({"a.txt": "one\n"})
    repo.write("a.txt", "one\ntwo\n")
    repo.git("add", "a.txt")

    ctx = context(
        is_repo=True,
        can_stage=False,
        payload=HookPayload(session_id="s1", timestamp=0, cwd=repo.path),
        files=[make_file("a.txt")],
    )
    with serve(ctx) as server:
        for route in ("api/stage", "api/unstage"):
            res = post(f"{server.url}{route}", json.dumps({"file": "a.txt"}))
            assert res.status == 409, f"{route} must refuse"
            assert res.json() == {"error": "staging does not apply to this review scope"}

    # The index is exactly as the test left it — the refused unstage did nothing.
    assert repo.git("diff", "--cached", "--name-only").strip() == "a.txt"


def test_stage_and_unstage_a_real_file(make_repo: RepoFactory) -> None:
    repo = make_repo({"a.txt": "one\n"})
    repo.write("a.txt", "one\ntwo\n")

    ctx = context(
        is_repo=True,
        can_stage=True,
        payload=HookPayload(session_id="s1", timestamp=0, cwd=repo.path),
        files=[make_file("a.txt")],
    )
    with serve(ctx) as server:
        staged = post(f"{server.url}api/stage", json.dumps({"file": "a.txt"}))
        assert staged.status == 200
        assert staged.json()["states"]["a.txt"] == "yes"

        unstaged = post(f"{server.url}api/unstage", json.dumps({"file": "a.txt"}))
        assert unstaged.status == 200
        assert unstaged.json()["states"]["a.txt"] == "no"


def test_a_git_failure_is_a_json_500_not_a_silent_200(make_repo: RepoFactory) -> None:
    """The page reads the body before the status, so a plain-text 500 throws there.

    Answering 200 with the unchanged states is worse still: the checkbox snaps
    back and the reviewer is told nothing at all.
    """
    repo = make_repo({"a.txt": "one\n"})
    ctx = context(
        is_repo=True,
        can_stage=True,
        payload=HookPayload(session_id="s1", timestamp=0, cwd=repo.path),
        # In the review's file set, so it clears the pathspec allow-list — but
        # not on disk, so `git add` fails the way a held index.lock would.
        files=[make_file("ghost.txt")],
    )
    with serve(ctx) as server:
        res = post(f"{server.url}api/stage", json.dumps({"file": "ghost.txt"}))
        assert res.status == 500
        assert "json" in (res.header("content-type") or "")
        body = res.json()
        assert re.search(r"could not stage ghost\.txt", body["error"])
        # The real states ride along so the page can reconcile the checkbox.
        assert isinstance(body["states"], dict)
        assert "ghost.txt" not in body["states"]


def test_malformed_stage_json_and_a_missing_file_are_both_400(make_repo: RepoFactory) -> None:
    repo = make_repo({"a.txt": "one\n"})
    ctx = context(
        is_repo=True,
        can_stage=True,
        payload=HookPayload(session_id="s1", timestamp=0, cwd=repo.path),
    )
    with serve(ctx) as server:
        bad = post(f"{server.url}api/stage", "{nope")
        assert bad.status == 400
        assert bad.json() == {"error": "invalid JSON"}

        missing = post(f"{server.url}api/stage", json.dumps({}))
        assert missing.status == 400
        assert missing.json() == {"error": "missing file"}


@pytest.mark.parametrize("bad", [":/", ":(exclude)a.txt", "b.txt", "../outside.txt"])
def test_a_path_outside_the_review_is_rejected(bad: str, make_repo: RepoFactory) -> None:
    """`--` stops git reading the argument as a flag or ref but does NOT disable pathspec magic.

    `:/` matches the whole repository, so only paths in this review may reach
    `git add`.
    """
    repo = make_repo({"a.txt": "one\n"})
    repo.write("b.txt", "two\n")
    ctx = context(
        is_repo=True,
        can_stage=True,
        payload=HookPayload(session_id="s1", timestamp=0, cwd=repo.path),
        files=[make_file("a.txt")],
    )
    with serve(ctx) as server:
        res = post(f"{server.url}api/stage", json.dumps({"file": bad}))
        assert res.status == 400, f"{bad} was not rejected"
        assert res.json() == {"error": "unknown file"}

    # Nothing was staged as a side effect.
    assert repo.git("diff", "--cached", "--name-only").strip() == ""


def test_an_unmerged_path_is_refused_leaving_the_conflict_intact(
    make_repo: RepoFactory,
) -> None:
    """`git reset -- <path>` on a conflicted path drops index stages 1/2/3.

    Status flips from UU to ` M` while MERGE_HEAD and the conflict markers
    remain, so the conflict looks resolved and the next commit records the
    markers as the resolution.
    """
    repo = make_repo({"a.txt": "base\n"})
    repo.git("checkout", "-b", "other")
    repo.write("a.txt", "theirs\n")
    repo.commit("theirs")
    repo.git("checkout", "main")
    repo.write("a.txt", "ours\n")
    repo.commit("ours")
    with pytest.raises(subprocess.CalledProcessError):
        repo.git("merge", "other")
    assert re.search(r"^UU a\.txt$", repo.git("status", "--porcelain"), re.MULTILINE)

    ctx = context(
        is_repo=True,
        can_stage=True,
        payload=HookPayload(session_id="s1", timestamp=0, cwd=repo.path),
        files=[make_file("a.txt")],
    )
    with serve(ctx) as server:
        for route in ("api/unstage", "api/stage"):
            res = post(f"{server.url}{route}", json.dumps({"file": "a.txt"}))
            assert res.status == 409, f"{route} must refuse an unmerged path"
            body = res.json()
            assert "unmerged" in body["error"]
            assert body["states"]["a.txt"] == "unmerged"

    # The conflict stages are still there — nothing was reset behind the reviewer.
    assert re.search(r"^UU a\.txt$", repo.git("status", "--porcelain"), re.MULTILINE)
    # Stages 1/2/3 (base/ours/theirs) are what `git reset` would have thrown away.
    stages = repo.git("ls-files", "-u", "a.txt").strip().split("\n")
    assert len(stages) == 3, f"expected three conflict stages, got: {' | '.join(stages)}"


def test_concurrent_stage_requests_do_not_race_the_index_lock(make_repo: RepoFactory) -> None:
    """git guards the index with .git/index.lock and a second writer fails outright.

    Overlapping `git add`s would otherwise surface to the reviewer as spurious
    500s on checkboxes they ticked in a hurry.

    `threading.Lock` is not FIFO and waitress serves on several threads, so
    *which* request lands last is not observable and is not asserted. The real
    invariants are: every request succeeds, each `states` map is internally
    consistent, and the index ends up holding all three files.
    """
    repo = make_repo({"a.txt": "one\n", "b.txt": "two\n", "c.txt": "three\n"})
    paths = ["a.txt", "b.txt", "c.txt"]
    for name in paths:
        repo.write(name, f"{name} changed\n")

    ctx = context(
        payload=HookPayload(session_id="s1", timestamp=0, cwd=repo.path),
        files=[make_file(p) for p in paths],
        is_repo=True,
        can_stage=True,
    )
    with serve(ctx) as server:

        def stage(name: str) -> tuple[int, str]:
            res = post(f"{server.url}api/stage", json.dumps({"file": name}))
            return res.status, res.text

        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(stage, paths))

    for name, (status, text) in zip(paths, results, strict=True):
        assert status == 200, f"{name} failed: {text}"
        states = json.loads(text)["states"]
        # Internally consistent: the file this request staged reads as staged.
        assert states[name] == "yes", f"{name} was not staged in its own response"

    # And every write actually landed, none lost to a held index.lock.
    staged = sorted(repo.git("diff", "--cached", "--name-only").strip().split("\n"))
    assert staged == paths


# --- method fall-through, size cap, lifecycle ------------------------------


def test_api_routes_ignore_the_wrong_method_and_fall_through_to_static() -> None:
    """A GET on a POST-only route is not an API hit; it looks for a file and 404s.

    One rule per route would answer 405 instead.
    """
    with serve() as server:
        assert get(f"{server.url}api/submit").status == 404
        assert get(f"{server.url}api/stage").status == 404


def test_an_oversized_body_is_a_413_and_leaves_the_review_pending() -> None:
    """This process is a blocking hook.

    Buffering an unbounded body until the heap gives out does not merely lose a
    review, it stalls the agent's turn until the hook timeout — and the Origin
    guard does not cover a local non-browser client. JSON, not a plain-text
    500: the page reads the body before the status.
    """
    with serve() as server:
        huge = json.dumps(
            {"decision": "approve", "summary": "x" * (5 * 1024 * 1024), "comments": []}
        )
        res = post(f"{server.url}api/submit", huge)
        assert res.status == 413
        assert res.json() == {"error": "request body too large"}
        assert not server.gate.settled


def test_close_makes_a_pending_review_raise_rather_than_hang_forever() -> None:
    server = start_review_server(context())
    server.close()
    with pytest.raises(ServerClosed, match="server closed before submission"):
        server.gate.wait()


def test_close_does_not_overwrite_an_accepted_verdict() -> None:
    """`close()` always runs, so `reject` after `resolve` would invert a real verdict."""
    with serve() as server:
        post(f"{server.url}api/submit", json.dumps({"decision": "request_changes"}))
        server.gate.wait()
    assert server.gate.wait().decision == "request_changes"


def test_close_is_safe_to_call_twice() -> None:
    with serve() as server:
        server.close()
    # The context manager closes it again on the way out; neither raises.


def test_the_port_is_released_once_close_returns() -> None:
    """Without `close_all` a browser keep-alive socket holds the listener open."""
    with serve() as server:
        port = port_of(server.url)
        get(server.url)
    with socket.socket() as probe:
        probe.settimeout(5)
        probe.bind(("127.0.0.1", port))
