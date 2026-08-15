# Revgate

revgate is a local, GitHub-style review page for the work of a Copilot agent.
You read the diff — or the plan — in a browser, write line comments, and give an
approve or request-changes verdict. revgate hands that feedback straight back to
the agent as its next prompt.

revgate is **manual-first, with one automatic exception**. A review starts when
you ask for one, or when the agent asks for one. Only the plan gate starts by
itself: it runs before Copilot leaves plan mode and begins to write code, so you
approve the plan before the work rather than the diff after it.

## Features

- **A pull-request page for local work.** Side-by-side diff, per-line and
  per-file comments, a summary, and an approve or request-changes verdict.
- **Agent-readable output.** The verdict and every comment come back as
  structured markdown on stdout, or in a file, with exact `path:line` anchors.
- **Automatic plan gate.** A Copilot `preToolUse` hook reviews the proposed plan
  before `exit_plan_mode` runs. Approve allows the tool; request changes denies
  it and returns your review as the reason.
- **Two skills.** `/revgate-review` and `/revgate-plan` let the agent open a
  review at a moment it or you choose.
- **Flexible scopes.** The working tree, the index, a ref, a range, a merge-base
  range, or a plan document — narrowed further with path include/exclude filters.
- **Staging from the page.** Toggle a file staged or unstaged while you review
  the working tree.
- **Real exit codes.** Exit `10` when the review captured comments, so a script
  or an agent can branch on it.
- **Review history.** Every review that captured something is archived as
  markdown, so it survives a hook timeout or a closed terminal.
- **Five colour themes** plus a System option that follows the OS live.
- **Private by construction.** The server binds a random port on `127.0.0.1`,
  rejects any request whose `Host` is not that exact loopback address, and
  accepts a POST only from its own origin. The page makes no outbound requests.

## Requirements

| | |
| --- | --- |
| **uv** | On your PATH; check with `uv --version`. Install from <https://docs.astral.sh/uv/>. No separate Python needed — `uv tool install` reads the `requires-python` floor and downloads a managed CPython 3.14. The supported build is the **default-GIL** CPython, not free-threaded `3.14t`: Flask, Werkzeug and waitress are not verified against it. |
| **Git** | To clone this repository, and to read the diff of the repository you review. |
| **GitHub Copilot** | For the skills and the plan gate. Any Copilot surface that reads `~/.copilot` and fires the `preToolUse` hook. |
| **A web browser** | For the review page. Open the URL exactly as revgate prints it: a proxy or port-forward that changes the port gets `403 unexpected host`. |
| **Windows / PowerShell** | For `install.ps1`. The CLI itself is cross-platform. |

## Installation

```powershell
git clone <repo-url> revgate
cd revgate
.\install.ps1
```

One route, no prompts. Each run:

1. Runs `uv tool install --force .`, putting the `revgate` CLI on your PATH.
2. Copies `assets\skills\*` into `%USERPROFILE%\.copilot\skills\`, which makes
   `/revgate-review` and `/revgate-plan` available.
3. Writes the global plan gate to `%USERPROFILE%\.copilot\hooks\revgate.json`,
   with the absolute path of the installed executable pinned into it.


The installer refuses to write the hook when the executable is missing, because
a `preToolUse` hook that cannot run fails **closed**.

```powershell
.\install.ps1 -Timeout 1800   # plan review timeout in seconds (default 3600)
.\install.ps1 -SkipInstall    # rewire the hook and skills, skip `uv tool install`
.\install.ps1 -Uninstall      # remove the global hook and the skills
.\install.ps1 -Help           # every installer switch
```

> If PowerShell blocks the script, either `Unblock-File .\install.ps1` once, or
> run `powershell -ExecutionPolicy Bypass -File .\install.ps1` for one session.

### Uninstall

`-Uninstall` removes the global hook and the skills; a second run is a no-op. uv
owns the CLI, so remove that separately with `uv tool uninstall revgate`.

## Usage

### On demand — `revgate review`

```
revgate review [<refs>] [options]
```

This is the on-demand entry point behind `/revgate-review` and `/revgate-plan`.
It is not a hook: it reads nothing from stdin, writes markdown annotations to
stdout, and uses real exit codes.

The positional arguments name what to review:

| Argument | Scope |
| --- | --- |
| *(none)* | the working tree against `HEAD`, plus untracked files |
| `<ref>` | `<ref>` against the working tree |
| `<a> <b>` | `<a>` against `<b>` |
| `<a>..<b>` | the same as two refs |
| `<a>...<b>` | `<a>` against `<b>` from their merge base |
| `--staged` | the index only; cannot be combined with refs |

A positional argument is always a ref, never a path: `revgate review src` looks
for a commit named `src` and exits 2. Use `-I src` to scope by path. Refs are
validated with `git rev-parse` before they reach `git diff`, so a typo is bad
usage rather than a git crash.

`--include` narrows first, then `--exclude` removes from what is left. Both match
a path prefix at a directory boundary — `-X src/generated` drops
`src/generated/g.ts` but keeps `src/generated-old.ts` — and both match against
paths **relative to the repository root**, unlike `git diff -- <pathspec>`. From
`pkg/` you still write `-I pkg/lib`, not `-I lib`. If the filters remove every
changed file, revgate prints `NOTHING IN SCOPE` and exits 2 rather than report an
approval nobody gave.

Untracked files join the working-tree scope only; a ref, a range and `--staged`
never pick them up. Untracked *content* is capped — 2 MB per file, 8 MB or 300
files per review — so a stray `dist/` cannot stall the gate. A file past a cap is
still listed, just unexpanded, with a warning on stderr. Tracked changes are
never elided.

The per-file **Staged** toggle appears in the working-tree and `--staged` scopes
only, because it acts on the index and would otherwise report a state unrelated
to the commits on the page. A path with an unresolved merge conflict shows as
**Unmerged** with its toggle disabled, and the API answers a stage request for it
with 409 — resolve the conflict in git first.

### Automatic — the plan gate

`revgate plan` is the `preToolUse` hook a normal install wires up:

1. Copilot enters plan mode. The agent drafts a plan, then calls `exit_plan_mode` to
   leave it.
2. `preToolUse` fires *before* that tool runs. The hook has no matcher, so
   `revgate plan` self-filters and passes every other tool straight through with
   `permissionDecision: allow`.
3. For `exit_plan_mode` it resolves the plan text and opens the review page. It
   reads `~/.copilot/session-state/<sessionId>/plan.md` first (`$COPILOT_HOME`
   overrides `~/.copilot`), then the inline plan in the hook payload
   (`toolArgs.plan` or `tool_input.plan`). A payload naming no session prefers
   its own inline plan, since the newest `plan.md` on disk may belong to another
   session or repository.
4. **Approve** returns `permissionDecision: allow` and the agent proceeds.
   **Request changes** returns `deny` with your review as the reason, so the
   agent revises the plan.

The gate **fails open**: if revgate cannot find plan text, or is interrupted, or
errors, it allows the tool through rather than blocking the agent. It always
exits 0 and speaks decision JSON, because Copilot fails a non-zero `preToolUse`
hook closed.

Use `revgate review --plan <file>` — the `/revgate-plan` skill — when you are not
in plan mode at all, when the agent wrote a plan to a file as ordinary work, or
when you want a second look at an approved plan. `--plan` is strict: an
unreadable path, an empty file, and a bare `--plan` with no `$REVGATE_PLAN_FILE`
all exit 2. It never falls back to a diff review, because exit 0 there reads as a
sign-off on a plan nobody saw.

### Output format

```text
# revgate review: REQUEST CHANGES
scope: main..feature
branch: feature
files: 3
comments: 3

The error handling needs another pass.

## src/app.ts:12-13 (+)
Extract this into a helper.
 It is duplicated in server.ts.

## src/git/exec.ts:40 (-)
Why was this guard removed?

## README.md
This file needs a section on the new flag.
```

- The leading section carries the verdict (`APPROVED` or `REQUEST CHANGES`) and
  the reviewer's summary, so a consumer knows the outcome without parsing records.
- Each `## ` line opens a record and names an exact location; everything up to
  the next `## ` line is that comment's body.
- `## path:LINE (+)` is one line on the **new** side, `## path:START-END (+)` a
  range, `(-)` the **old** side, and `## path` alone a file-level comment.
- Continuation lines are indented by one space so a body can never look like a
  record header. A first line starting with `#` is indented for the same reason.
- `scope:` is a human-readable label, not a rerunnable command line. Path filters
  append `[+<include> -<exclude>]`.
- A plan review adds `mode: plan` and omits `scope:`; its records point into the
  plan document, whose synthetic filename is always `Plan`.
- `untracked-scan: failed` or `dropped-paths: <n>` in the leading section means
  the review was **incomplete** — act on the records, then say the review did not
  cover everything.

### Review history

Every review that captured something — a comment, or a request-changes verdict —
is archived as markdown on both the skill and the `plan` path:

```
<historyDir>/<repo-name>/<timestamp>.md
```

`<historyDir>` is `--history-dir`, else `$REVGATE_HISTORY_DIR`, else
`~/.revgate/history`. `<repo-name>` is the basename of the git toplevel, or
`no-repo` outside a repository. The file opens with YAML frontmatter — date,
repo, mode, session, scope, branch — followed by the same annotation records.

An approval with no comments is not archived. A history failure never fails a
review: revgate warns on stderr and continues, so a read-only home directory
cannot wedge a gate. `--no-history` opts out for one run.

### Themes

The page ships five built-in palettes, picked from the dropdown in its header:
**Dark Modern** (default dark), **Light Modern** (default light), **Monokai**,
**Solarized Light** and **Dracula**. The default selection is **System**, which
follows `prefers-color-scheme` and re-resolves live — flip your OS theme
mid-review and the page follows without a reload.

Your pick is saved server-side in `~/.revgate/config.json`:

```json
{ "theme": "dracula" }
```

It has to live on disk: the random port makes every run a distinct browser
origin with its own empty `localStorage`, so a browser-side store would forget
the choice each time.

Theme handling never fails a review. A missing config is the normal first run and
passes silently. An unreadable config, a malformed one, an unknown theme id, or
an unwritable home directory falls back to `system`, and the last three warn on
stderr. A failed save is reported on stderr only, because an error response would
make the page undo a change you can plainly see. If the themes cannot load at
all, the page renders without the picker.

## Options

| Flag | Meaning |
| --- | --- |
| `--staged` | Review the staged changes only |
| `-I`, `--include <path>` | Review only paths starting with `<path>`. Repeatable |
| `-X`, `--exclude <path>` | Skip paths starting with `<path>`. Repeatable |
| `--plan [<file>]` | Review a plan document instead of a diff |
| `-o`, `--output <file>` | Write annotations to `<file>` instead of stdout. On a write failure revgate falls back to stdout with a warning, so a captured verdict is never dropped |
| `--exit-code-on-comments` | Exit `10` when the review captured comments or requested changes |
| `--history-dir <dir>` | Save reviews under `<dir>`. Beats `$REVGATE_HISTORY_DIR` |
| `--no-history` | Do not archive this review |
| `--no-open` | Do not open the browser automatically |
| `-h`, `--help` | Show the usage text |

`--staged`, `--no-open`, `--no-history`, `--exit-code-on-comments` and `-h` are
switches. `--no-history=false` is a usage error (exit 2), not "keep the history":
accepting a value and discarding it inverts the caller's intention in silence,
and the primary caller is an agent. Omit the flag to get the default.

A flag that *takes* a value rejects an empty one, so `-o ""`, `-I ""` and
`--history-dir ""` are usage errors too. A skill can easily interpolate an unset
shell variable — `-o "$OUT"` — and must not silently get behaviour it never asked
for.

### Environment variables

| Variable | What it names | Resulting path |
| --- | --- | --- |
| `$REVGATE_CONFIG_DIR` | the directory holding `config.json` | `<dir>/config.json` |
| `$REVGATE_HISTORY_DIR` | the history directory itself | `<dir>/<repo>/<timestamp>.md` |
| `$REVGATE_PLAN_FILE` | the plan file a bare `--plan` reads | — |
| `$COPILOT_HOME` | Copilot's home, in place of `~/.copilot` | `<dir>/session-state/…` |

The first two deliberately have different shapes; the defaults are `~/.revgate`
and `~/.revgate/history`. Do not give `$REVGATE_CONFIG_DIR` a history-shaped path.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The review completed: approved, or nothing to review, or comments captured *without* `--exit-code-on-comments` |
| `10` | Comments were captured. Requires `--exit-code-on-comments` |
| `1` | An unexpected error, or the review stopped before a verdict was submitted |
| `2` | Bad usage: an unknown flag, a mistyped subcommand, a value on a valueless switch, a ref that does not resolve, a scope flag alongside `--plan`, a `--plan` with no plan text behind it, filters that removed every changed file, a working directory that is not a git repository, or a failed untracked-file scan |

Without `--exit-code-on-comments`, **every** completed review exits `0` whatever
the verdict. Pass the flag, or parse the `# revgate review:` line. Do not read
`0` as "approved".

Failure banners are deliberately distinct from approval:

- An interrupted review reports `NO REVIEW CAPTURED` and exits 1. A run outside a
  repository reports the same banner and exits 2 — that is a wrong directory, not
  an approval.
- A failed untracked scan reports `SCAN FAILED` with `untracked-scan: failed` and
  exits 2, writing git's reason to stderr. Many turns produce only new files, and
  such a turn would otherwise look like an empty diff. This one is an environment
  failure rather than a bad command line, so a retry is reasonable. If tracked
  files *were* reviewed, the reviewer's verdict stands, the header line rides
  along, and the page carries a banner saying new files are missing.
- A changed file whose path contains a line break is never rendered, because such
  a path can splice forged `## path:line` records into the output. If that leaves
  nothing, revgate reports `PATHS DROPPED` with a `dropped-paths:` count and exits
  2; otherwise the verdict stands and the count rides along in the header.

Anything that is not `revgate review …` or `revgate plan` is bad usage,
exit 2 — including a mistyped subcommand, review flags with the subcommand
dropped, and bare `revgate`. A typo must never be able to forge a clean review,
and a stale hook must fail loudly rather than gate in silence.

## Examples

```bash
revgate review                                    # every uncommitted change
revgate review --staged                           # what you are about to commit
revgate review HEAD~3                             # the last three commits and the working tree
revgate review main feature                       # two refs
revgate review main..feature                      # a branch, as a pull request shows it
revgate review main...feature                     # the same, from the merge base
revgate review main..feature --include src        # only the src/ part of it
revgate review -I src -I public -X src/generated  # the filters compose
revgate review --exit-code-on-comments            # exit 10 if there is work to do
revgate review -o review.md main..feature         # write the annotations to a file
revgate review --no-open                          # print the URL, open it yourself
revgate review --plan docs/plans/my-plan.md       # review a plan document
revgate review --no-history --staged              # do not archive this one
```

In a Copilot session:

```
/revgate-review        # review what the agent just did
/revgate-plan          # review a plan document on demand
```

## Development

```bash
uv sync --all-groups   # create .venv, install runtime and dev groups
uv run ruff check      # lint
uv run ruff format     # format
uv run mypy            # types, strict mode
uv run pytest          # the whole suite
uv run revgate review  # the UI against your working tree, straight from the checkout
```

Those four checks are the gate; every change must leave all four green.

`src/revgate/` groups code by concern, one package each:

| Package | Concern |
| --- | --- |
| `cli/` | argv, the help text, and the body of each command |
| `git/` | every call to git, the scopes, the untracked budget, and the index |
| `review/` | the diff parser, the plan, the feedback, and the report |
| `server/` | the local review server and its HTTP guards |
| `integrations/` | clients for other products; today Copilot only |
| `store/` | the history files, the palettes, and the config file |
| `shared/` | shared types, the stderr logger, and the stdout discipline |

`__main__.py` stays at the package root and dispatches only. `tests/` mirrors the
same shape. `src/revgate/public/` ships with the package: `index.html` for the
markup, `app.css` for the style, `app.js` for the page script. `agents.md` lists
every module and holds the rules that keep this structure honest.

`assets/` holds everything the installer ships rather than imports, one folder
per destination: `assets/skills/` is the only skill tree, copied unchanged into
`%USERPROFILE%\.copilot\skills\`, and `assets/hooks/revgate.json` is a reference
template;
the installer generates a copy with the absolute path of the installed executable
and writes it only to the global `%USERPROFILE%\.copilot\hooks\`. Both wrap the
`preToolUse` command in an existence check on that executable, because the hook
fails closed — without the check, an uninstall or a mistyped path denies every
tool call in every session until somebody hand-edits the JSON.

Three rules to know before changing anything:

- **stdout is a contract.** Every log line goes to stderr (`shared/log.py`),
  because Copilot parses stdout. `shared/streams.py` pins stdout to UTF-8 with no
  newline translation, since the Windows defaults break every byte contract in
  the project. Do not widen what reaches stdout without an explicit mode flag.
- **The hook fails open.** Every error path of `revgate plan` writes an
  explicit `allow` and exits 0. Only `revgate review` may exit non-zero.
- **Comments are moderate.** One-line docstring on each public symbol in
  `src/revgate/`; a short "why" note only where the code is not obvious. The full
  reasoning belongs in the Rules of `agents.md`.

Every flag in `--help` must appear in this document, and `agents.md` must list
every module. Update both in the same commit as the code.
