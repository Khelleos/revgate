# revgate

Tiny local web UI that lets you review a Copilot agent's work like a GitHub PR —
line comments, an approve / request-changes verdict, and your feedback handed
straight back to the agent as its next prompt.

revgate is **manual-first, with one automatic exception**: reviews run when you
(or the agent) ask for one, and the single thing that fires on its own is the
plan gate — before Copilot leaves plan mode and starts writing code, you review
the plan it proposed.

## Two ways to run revgate

Both ways share the same UI, the same review pipeline, and the same history.

| | Skill / CLI (the default) | Plan hook (the exception) |
| --- | --- | --- |
| How it starts | `/revgate-review` or `/revgate-plan` in Copilot CLI, or `revgate review` in a terminal | Copilot's `preToolUse` hook, via `revgate copilot-plan` |
| When | Exactly when asked | Every exit from plan mode |
| Scope | Any refs, range, `--staged`, path filters — or a plan file | The proposed plan |
| Output | Markdown annotations on stdout (or `--output <file>`) | Permission decision JSON on stdout |
| Signal | Exit code `10` when comments were captured | `deny` / `allow` |
| Install | `.\install.ps1` | the same `.\install.ps1` run wires it |

The skill is the "review what you just did, scoped to `src/`" tool — the agent
runs it at a moment of its (or your) choosing, reads structured markdown back,
and acts on it. The plan hook is the one checkpoint that stays automatic,
because a plan approved before implementation is cheap and a wrong plan
implemented is not. There is deliberately **no** automatic diff gate: earlier
versions shipped an `agentStop` hook that opened a review at every turn end, and
it was removed in 0.2.0 in favour of reviewing on demand.

## Requirements

- **Node.js ≥ 18** on your PATH (`node --version`). The installer builds from
  source, so npm comes with it. No runtime dependencies.
- **Git** — to clone this repo, and so revgate can read the diff of the repo
  you're reviewing.
- **GitHub Copilot CLI** (or another surface that fires the `preToolUse` hook,
  e.g. VS Code Copilot agent mode) for the plan gate. Skills need Copilot CLI.
  (The JetBrains plugin is not known to support these hooks.) The CLI
  (`revgate review`) itself needs neither — any terminal will do.
- **A web browser** for the review UI (served locally on `127.0.0.1`, random
  port). Open the URL revgate prints, as printed: the server answers only
  requests whose `Host` is loopback on that exact port, and accepts a POST only
  from its own origin — otherwise a page that rebound DNS to 127.0.0.1 could read
  the whole diff, and any open tab could forge an approval. A proxy or a
  port-forward that rewrites the port gets a `403 unexpected host`.

## Install

Clone, then run the installer in PowerShell. It builds revgate, puts the
`revgate` CLI on your PATH, installs the `/revgate-review` and `/revgate-plan`
skills, and wires the one automatic hook (the plan gate) for you — no
hand-editing paths, no separate npm commands.

```powershell
git clone <repo-url> revgate
cd revgate
.\install.ps1
```

There is one install route and no prompt: every run installs the CLI, both
skills, and the global plan gate at `%USERPROFILE%\.copilot\hooks\revgate.json`,
so the gate covers every repository you work in.

```powershell
.\install.ps1 -Timeout 1800        # plan review timeout in seconds (default 3600)
.\install.ps1 -Help                # every installer switch
```

Every install copies `.github\skills\*` into `%USERPROFILE%\.copilot\skills\`,
which is what makes `/revgate-review` and `/revgate-plan` available in Copilot
CLI. Run `/skills reload` afterwards. The skills call the `revgate` bin, so
every install also runs `npm install -g .` from this clone to put it on your
PATH; the plan hook pins the absolute `node dist/index.js` path and needs
nothing on PATH.

> If PowerShell blocks the script, either unblock it once with
> `Unblock-File .\install.ps1`, or run it in a single session with
> `powershell -ExecutionPolicy Bypass -File .\install.ps1`.

### Upgrade

The installer writes a *snapshot* of the hook config, so a change to the hook
set does not reach an existing install until you re-run it:

```powershell
git pull
.\install.ps1                    # rewrites the hook file, rebuilds dist/ and the global CLI, refreshes the skills
```

**Upgrading from 0.1.x:** the `agentStop` diff gate was removed. Re-running the
installer rewrites the hook file with only the `preToolUse` plan gate; until you
do, the stale hook still invokes bare `revgate` at every turn end, which now
exits 2 with a message pointing back here rather than opening a review. Check
what you currently have with
`Get-Content $env:USERPROFILE\.copilot\hooks\revgate.json` — it should list
`preToolUse` and nothing else. Add `-SkipBuild` to rewire an existing `dist/`
without re-running any npm step — dependency install, `tsc`, and the global CLI
install are all skipped.

## Verify

```powershell
node dist\index.js review --help              # every flag
node dist\index.js review                     # diff review against your working tree
```

This opens the review UI directly so you can confirm it works before relying on
the hook — with a completely clean tree there is nothing to review, so touch a
file first. Add `--no-open` if you'd rather open the printed URL yourself.

## `revgate review`

The on-demand entry point. Not a hook: it takes nothing on stdin, writes markdown
annotations (never hook JSON) to stdout, and uses real exit codes.

```
revgate review [<refs>] [options]
```

### Scopes

Positional arguments mirror revdiff:

| Argument | What is reviewed |
| --- | --- |
| *(none)* | working tree vs `HEAD` — including untracked files |
| `<ref>` | `<ref>` vs the working tree, e.g. `revgate review HEAD~3` |
| `<a> <b>` | `<a>` vs `<b>`, e.g. `revgate review main feature` |
| `<a>..<b>` | same as two refs, e.g. `revgate review main..feature` |
| `<a>...<b>` | `<a>` vs `<b>` from their merge base |
| `--staged` | the index only (cannot be combined with refs) |

Untracked files are only synthesized into the working-tree scope; a ref, range or
staged scope never picks them up. Every ref is validated with `git rev-parse`
before it reaches `git diff`, so a typo is reported as bad usage (exit 2), not as
a git crash.

Untracked *content* is capped, so an un-ignored `dist/` or a stray data dump
can't stall the gate: a single untracked file over 2 MB, or anything past 8 MB
or 300 files across one review, is still listed but shown unexpanded — the same
rendering as a binary file — with a warning on stderr. Tracked changes are never
elided, and nothing is ever dropped: a file you cannot expand is still a file you
can see was added.

The UI's per-file **Staged** toggle is offered in the working-tree and `--staged`
scopes only. Staging acts on the working tree, so in a ref or range review it
would report an index state that says nothing about the commits on screen — and
staging from there would `git add` content that is not in the reviewed diff.

A path with an unresolved merge conflict shows as **Unmerged** with its toggle
disabled, and the API answers a stage request for it with 409. Its index entry
holds the conflict stages rather than a staged/unstaged split, so unstaging would
drop them: the conflict markers would stay on disk while git stopped calling the
file conflicted — and the next commit would record the markers as the resolution.
Resolve it in git first.

### Options

| Flag | Meaning |
| --- | --- |
| `--staged` | Review staged changes only |
| `-I`, `--include <path>` | Only review paths starting with `<path>` (repeatable) |
| `-X`, `--exclude <path>` | Skip paths starting with `<path>` (repeatable) |
| `--plan [<file>]` | Review a plan document instead of a diff |
| `-o`, `--output <file>` | Write the annotations to `<file>` instead of stdout (falls back to stdout, with a warning, if the file can't be written — a captured verdict is never dropped) |
| `--exit-code-on-comments` | Exit `10` when the review captured comments or requested changes |
| `--history-dir <dir>` | Save reviews under `<dir>` (beats `$REVGATE_HISTORY_DIR`) |
| `--no-history` | Don't archive this review |
| `--no-open` | Don't auto-open the browser |
| `-h`, `--help` | Show usage |

`--staged`, `--no-open`, `--no-history`, `--exit-code-on-comments` and
`-h` are switches with no value: `--no-history=false` is a usage error (exit 2),
not "keep the history". Omit the flag to get the default. Accepting and
discarding the value would invert the caller's intent in silence, and the primary
caller is an agent.

Conversely, a flag that *takes* a value rejects an empty one: `-o ""`, `-I ""` or
`--history-dir ""` is a usage error (exit 2), not "no output file" / "no filter".
A skill interpolating an unset shell variable (`-o "$OUT"`, `-I "$SCOPE"`) would
otherwise get silently different behaviour than it asked for.

`--include` narrows first, then `--exclude` removes from what's left — the same
composition revdiff documents. Both match on path prefixes, at directory
boundaries: `-X src/generated` drops `src/generated/g.ts` but keeps
`src/generated-old.ts`.

Prefixes are matched against **repository-root-relative** paths, not against the
current directory the way `git diff -- <pathspec>` is — so from `pkg/` you still
write `-I pkg/lib`, not `-I lib`. If the filters remove every changed file the
review is *not* reported as an approval: revgate prints a `NOTHING IN SCOPE`
report and exits `2`, since nobody looked at anything.

A positional argument is always a ref, never a path — `revgate review src` looks
for a commit named `src` and exits 2. Use `-I src` to scope by path.

### Examples

```bash
revgate review                                    # everything uncommitted
revgate review --staged                           # what you're about to commit
revgate review HEAD~3                             # the last three commits + working tree
revgate review main..feature                      # a branch, as a PR would show it
revgate review main..feature --include src        # …only the src/ part of it
revgate review -I src -I public -X src/generated  # filters compose
revgate review --exit-code-on-comments            # exit 10 if there's work to do
revgate review -o review.md main..feature         # archive the annotations somewhere
```

### Output format

`revgate review` prints a leading section with the verdict, then one **record**
per comment:

```text
# revgate review: REQUEST CHANGES
scope: main..feature
branch: feature
files: 2
comments: 3

The error handling needs another pass.

## src/app.ts:12-13 (+)
Extract this into a helper.
 It is duplicated in server.ts.

## src/git.ts:40 (-)
Why was this guard removed?

## README.md
This file needs a section on the new flag.
```

- The leading section is the reviewer's verdict (`APPROVED` / `REQUEST CHANGES`)
  and summary, so a consumer never has to parse records to know the outcome.
- Every `## ` line opens a record naming an exact location; everything beneath it
  up to the next `## ` is that comment's body.
- `## path:LINE (+)` is one line on the **new** side, `## path:START-END (+)` a
  range, `(-)` the **old** (pre-change) side, and `## path` alone is a file-level
  comment.
- Continuation lines in a body are indented by one space, so a body can never be
  mistaken for a record header. A body's first line is flush — except when it
  starts with `#`, which would open a bogus record, so that one is indented too.
- `scope:` is a human-readable label, not a re-runnable command line:
  `working tree vs HEAD`, `staged changes`, `HEAD~3 vs working tree`, or
  `main..feature`, with `[+<include> -<exclude>]` appended when path filters were
  applied.
- A plan review adds a `mode: plan` line to the leading section and emits **no**
  `scope:` line, since there is no diff behind it. Its records point into the plan
  document: the synthetic file is always named `Plan`, so every header reads
  `## Plan:<line> (+)`.
- Two more leading-section lines mean the review was **incomplete**, and they
  appear on an ordinary `APPROVED` / `REQUEST CHANGES` report as readily as on the
  exit-2 reports below: `untracked-scan: failed` (new files could not be listed,
  so none of them were reviewed) and `dropped-paths: <n>` (that many changed files
  carry a line break in their path and were never rendered). Act on the records,
  then say the review did not cover everything.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Review completed — approved, nothing to review, or comments were captured on a run *without* `--exit-code-on-comments` |
| `10` | Comments were captured (only with `--exit-code-on-comments`) |
| `1` | Unexpected error, or the review was interrupted before a verdict was submitted |
| `2` | Bad usage — unknown flag, a mistyped subcommand, a value on a valueless switch, a ref that doesn't resolve, a scope flag alongside `--plan`, a `--plan` with no plan text behind it, `-I`/`-X` filters that removed every changed file, a working directory that isn't a git repository, or an untracked-file scan that failed |

Without `--exit-code-on-comments` **every** completed review exits `0`, whatever
the verdict — so either pass the flag, or parse the `# revgate review:` line
rather than reading `0` as "approved".

`--plan` is strict about finding a plan: an unreadable path, an existing but
empty file, and a bare `--plan` with no `$REVGATE_PLAN_FILE` set all exit 2.
`revgate review --plan` never silently falls back to reviewing the diff, because
exit 0 there reads as a sign-off on a plan nobody saw.

An interrupted review reports `# revgate review: NO REVIEW CAPTURED` and exits 1
rather than `APPROVED` and 0: nobody approved anything, and an agent must not
read our own failure as a human sign-off. Running outside a repository reports
the same banner and exits 2 for the same reason — it is a wrong directory, not
an approval.

If listing untracked files fails, every new file is missing from the diff — and
for the common turn whose whole output *is* new files, that leaves an empty diff
that would otherwise read as "nothing to review". revgate reports
`# revgate review: SCAN FAILED` with an `untracked-scan: failed` line and exits
`2` instead, with git's reason on stderr. Unlike the other exit-2 causes this one
is an environment failure rather than a bad command line, so re-running is
reasonable. When tracked files *were* reviewed the human's verdict stands, the
same `untracked-scan: failed` line rides along on the report, and the review page
carries a banner saying new files are missing — so neither the reviewer nor the
report claims to cover the whole turn.

A changed file whose path contains a line break is never rendered — it would
splice forged `## path:line` records into the annotation output — and if that
leaves nothing to review, the same rule applies: revgate reports
`# revgate review: PATHS DROPPED` with a `dropped-paths:` count and exits `2`
rather than approving a diff those files never reached. When other files *were*
reviewed, the verdict stands and the count rides along as a `dropped-paths:`
header line, so the report never claims to cover more than it does.

Anything that is not `revgate review …` or `revgate copilot-plan` is bad usage,
exit 2: a mistyped subcommand (a typo like "reviw" will not quietly review a git
ref of that name), review flags with the subcommand dropped, and bare `revgate` —
which was the removed `agentStop` diff gate, and now prints a pointer to
re-running the installer instead of opening a review. A typo must never be able
to forge a clean review, and a stale hook must fail loudly rather than gate in
silence.

The hook path is deliberately *not* like this: `copilot-plan` always exits 0
and speaks decision JSON, because Copilot fails a `preToolUse` hook **closed**
on a non-zero exit.

### Review history

Every review that captured something — a comment, or a request-changes verdict —
is archived as markdown, on both paths (skill and `copilot-plan`):

```
<historyDir>/<repo-name>/<timestamp>.md
```

`<historyDir>` is `--history-dir`, else `$REVGATE_HISTORY_DIR`, else
`~/.revgate/history`. `<repo-name>` is the git toplevel's basename (`no-repo`
outside a repository). The file is YAML frontmatter — date, repo, mode, session,
scope, branch — followed by the same annotation records shown above, so a review
survives a hook timeout, a closed terminal, or an agent that ignored it.

Approvals with no comments are not archived. History failures never fail a
review: they warn to stderr and continue, so a read-only home directory can't
wedge a gate. Opt out per-run with `--no-history`.

### Themes

The review page ships five built-in colour themes, picked from the dropdown in
its header:

| Theme | Kind |
| --- | --- |
| Dark Modern | the default dark palette |
| Light Modern | the default light palette |
| Monokai | dark |
| Solarized Light | light |
| Dracula | dark |

The default is **System**, which is a real choice rather than the absence of
one: it follows the OS through `prefers-color-scheme`, resolving to Dark Modern
or Light Modern, and re-resolves live — flip your OS between light and dark
mid-review and the page follows without a reload.

Your pick is saved server-side, in:

```
~/.revgate/config.json
```

```json
{ "theme": "dracula" }
```

It has to live on disk rather than in the browser. The review server binds a
random port, so every run is a distinct origin with its own empty
`localStorage` — a browser-side store would forget the choice the moment the
review closed, every time.

`$REVGATE_CONFIG_DIR` overrides **the directory the config file lives in**; the
file inside it is always named `config.json`. Note this is deliberately not the
same shape as `$REVGATE_HISTORY_DIR`, which names the history directory
*itself*:

| Variable | What it names | Resulting path |
| --- | --- | --- |
| `$REVGATE_CONFIG_DIR` | the directory *holding* `config.json` | `<dir>/config.json` |
| `$REVGATE_HISTORY_DIR` | the history directory itself | `<dir>/<repo>/<timestamp>.md` |

So the defaults are `~/.revgate` and `~/.revgate/history` respectively — setting
`$REVGATE_CONFIG_DIR` to a `history`-shaped path is the mistake to avoid.

Theme handling never fails a review. A missing config is the normal first run
and is silent; an unreadable or malformed one, a saved id this version doesn't
know, or a home directory that can't be written falls back to `system`, and the
last three warn to stderr. Saving is best-effort in the same spirit: a write
that fails is reported to stderr only, because answering an error would make the
page undo a change you can plainly see. If the page can't load the themes at all
it renders without the picker rather than not rendering. A cosmetic subsystem
must not be able to wedge a gate.

Themes are the built-in five only — see "Design notes" for why user-authored
theme files were deferred.

## Plan review

revgate can also gate the agent *before* it writes code — reviewing the **plan**
it proposes instead of the resulting diff. Approve and the agent proceeds with
the plan; request changes and your feedback becomes the agent's next prompt, so
it revises the plan first.

There are two ways in, matching the two ways to run revgate:

- **Automatic** — Copilot's `preToolUse` hook via `revgate copilot-plan`. This
  is revgate's one automatic gate, and a normal install wires it.
- **On demand** — `revgate review --plan <file>` (the `/revgate-plan` skill), for
  when you're not in Copilot plan mode at all, when the plan is a file the agent
  wrote as ordinary work, or when you want a second look at an approved plan.

How the hook works:

1. In Copilot CLI, `Shift+Tab` enters plan mode; the agent drafts a plan and
   calls the `exit_plan_mode` tool to leave it.
2. `preToolUse` fires *before* that tool runs. The hook has no matcher and fires
   for every tool, so `revgate copilot-plan` self-filters: any tool other than
   `exit_plan_mode` is passed straight through (`permissionDecision: allow`).
3. For `exit_plan_mode`, revgate resolves the plan text — from
   `~/.copilot/session-state/<sessionId>/plan.md`, where Copilot writes it
   (`$COPILOT_HOME` overrides `~/.copilot`), otherwise from the hook payload
   (`toolArgs.plan` / `tool_input.plan`) — and opens the review UI. A payload
   that names no session prefers its own inline plan, since without a session id
   the newest `plan.md` on disk may belong to a different session or a different
   repository; only a payload carrying neither a session id nor an inline plan
   falls back to that cross-session scan.
4. **Approve** → `permissionDecision: allow`, the tool runs and the agent
   proceeds. **Request changes** → `permissionDecision: deny`, and your review is
   handed back as the reason so the agent revises the plan.

The plan hook **fails open**: if revgate can't find plan text, is interrupted, or
errors, it allows the tool through rather than blocking the agent.

The review UI, line comments, and approve / request-changes verdict are identical
to diff review — each plan line is commentable, and your notes are quoted back to
the agent.

`revgate review --plan <file>` (or bare `--plan` with the `REVGATE_PLAN_FILE`
env var set) reviews a plan file and prints annotations, which is what the skill
needs. The hook needs no file at all — it resolves the plan from Copilot's own
session state, as described above.

## Uninstall

```powershell
.\install.ps1 -Uninstall           # removes the global hook AND the skills
```

`-Uninstall` removes what the install wrote: the global hook and the skills.
Running it twice is a no-op. The globally installed CLI is npm's to manage and
is left in place — remove it with `npm uninstall -g revgate` (the uninstaller
reminds you).

## Develop

```bash
npm install            # also builds, via the `prepare` script — a type error fails the install
npm run build          # compile TypeScript to dist/
npm test               # node:test suite via tsx (needs Node >= 21 — see below)
npm run dev -- review  # run the UI against your working tree without building
```

revgate itself runs on Node ≥ 18, but `npm test` needs **Node ≥ 21**: the test
script passes a glob to `node --test`, and expanding one is a feature of the
runner rather than of the shell. Everything else in this list works on 18.

`.github/skills/` is the only skill tree — the installer copies it verbatim
into `%USERPROFILE%\.copilot\skills\`. `hooks/revgate.json` is a reference
template — the installer generates a copy with the correct absolute path to this
clone's `dist/index.js` and writes it only to the global
`%USERPROFILE%\.copilot\hooks\`. The installer no longer writes
`.github/hooks/`, but the directory stays gitignored: a hand-copied template
there would pin one machine's path, and committing it would hand every other
clone a hook that cannot run. Both the template and the generated copy wrap the `preToolUse` command in
an existence check on `dist/index.js`, because that hook fails **closed**: a
clone that moved, a cleaned `dist/`, or a mistyped path would otherwise deny
every tool call in every session until someone found and hand-edited the JSON.

`test/docs.test.ts` guards this file and `agents.md` the same way: every flag in
`--help` must appear in the README, and every quoted revgate command line here
must parse through `parseArgs`. Update the docs in the same commit as the code.

Two rules worth knowing before changing anything:

- **stdout is a contract.** All logging goes to stderr (`src/log.ts`) because
  Copilot parses stdout. Never widen what reaches stdout without an explicit mode
  flag.
- **The hook fails open.** Every error path on `revgate copilot-plan` emits an
  explicit `allow` and exits 0. Only `revgate review` may exit non-zero.

## Design notes: what we took from revdiff

The on-demand invocation model here is lifted from
[umputun/revdiff](https://github.com/umputun/revdiff), a standalone AI code
reviewer that agents drive through skills and slash commands. Specifically:
positional ref scoping and `--staged`, `--include`/`--exclude` and their
narrow-then-remove composition, the `## path:LINE (+)` annotation record format
with space-indented continuation lines, `-o`/`--output`, exit code `10` for
"comments were captured", and `<historyDir>/<repo>/<timestamp>.md` history.

So is the overall posture: revdiff is manual-first, with automatic plan review
as its one hook-driven exception (the `revdiff-planning` plugin), and since
0.2.0 revgate follows the same shape — the `agentStop` diff gate that once
fired at every turn end is gone, and the `preToolUse` plan gate is the only
thing that runs unasked.

Adopted in **reduced** form:

- **Themes**, as the five built-ins above and nothing else. revdiff's themes are
  a TUI feature; the palettes port to a browser page, the loader for
  user-authored theme files does not — see below.
- **A config file**, holding exactly one key. This one was on the deferred list
  until themes landed, on the reasoning that flags plus `$REVGATE_HISTORY_DIR`,
  `$REVGATE_PLAN_FILE` and `$COPILOT_HOME` covered everything it would hold.
  That turned out to be wrong for anything the *page* chooses: the random port
  means each run is a fresh browser origin, so no browser-side store can persist
  a preference across reviews. `~/.revgate/config.json` exists for precisely
  that gap, and holds only what falls into it.

Deliberately **not** adopted, because revgate is a browser UI rather than a TUI
and a human is the reviewer rather than an LLM:

- the terminal UI, vim motions and blame view
- Mercurial / Jujutsu support
- `--stdin` and `--only`
- user-authored themes — dropping a JSON theme into `~/.revgate/themes/`. The
  file format is the small part; what makes it usable is the bootstrap around it
  (dump a valid starting file, validate before adopting, ship examples to copy),
  and without that a user hand-authors against one README example and sees a
  validation failure only as a stderr warning nobody reads. It would also be the
  one place this feature has to start policing colour *values*, since a
  hand-written `url(…)` would fire an outbound request from a page that is
  otherwise deliberately network-free.

revgate keeps what revdiff doesn't have: a Copilot-native plan gate, and a
browser review UI where a person leaves the comments.
