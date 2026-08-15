# revgate

revgate is a small local web page. On it you review the work of a Copilot agent,
in the way that you review a GitHub pull request. You write line comments. You
give an approve or request-changes verdict. revgate then hands your feedback
straight back to the agent, as its next prompt.

revgate is **manual-first, with one automatic exception**. A review starts when
you ask for one, or when the agent asks for one. Only the plan gate starts by
itself. It runs before Copilot leaves plan mode and starts to write code. You
then review the plan that Copilot proposes.

## Two ways to run revgate

Both ways use the same page, the same review pipeline and the same history.

| | Skill or CLI (the default) | Plan hook (the exception) |
| --- | --- | --- |
| How it starts | `/revgate-review` or `/revgate-plan` in Copilot CLI, or `revgate review` in a terminal | Copilot's `preToolUse` hook, through `revgate copilot-plan` |
| When | Only when you ask | At each exit from plan mode |
| Scope | Any refs, a range, `--staged`, path filters, or a plan file | The proposed plan |
| Output | Markdown annotations on stdout, or in `--output <file>` | A permission decision as JSON on stdout |
| Signal | Exit code `10` when revgate captured comments | `deny` or `allow` |
| Install | `.\install.ps1` | the same `.\install.ps1` run wires it |

The skill is the tool for "review what you just did, in `src/`". The agent runs
it at a moment that it or you choose. It reads structured markdown back, and it
acts on that markdown. The plan hook is the one checkpoint that stays automatic.
A plan that you approve before the work is cheap. A wrong plan that the agent
implements is not cheap. There is deliberately **no** automatic diff gate.
Release 0.2.0 removed the `agentStop` hook that opened a review at each end of a
turn, in favour of a review on demand.

## Requirements

- **Node.js 18 or later** on your PATH. Test it with `node --version`. The
  installer builds from source, thus npm comes with Node. revgate has no runtime
  dependencies.
- **Git**, to clone this repository, and to let revgate read the diff of the
  repository that you review.
- **GitHub Copilot CLI** for the plan gate. Another surface that fires the
  `preToolUse` hook also works, for example VS Code Copilot agent mode. The
  skills need Copilot CLI. The JetBrains plugin is not known to support these
  hooks. The `revgate review` command needs none of these, and any terminal is
  sufficient.
- **A web browser** for the review page. The server listens on `127.0.0.1` on a
  random port. Open the URL that revgate prints, exactly as it prints it. The
  server answers only a request whose `Host` is loopback on that exact port, and
  it accepts a POST only from its own origin. Without these two rules, a page
  that rebinds DNS to 127.0.0.1 can read the whole diff, and any open tab can
  forge an approval. A proxy or a port-forward that changes the port gets a
  `403 unexpected host`.

## Install

Clone the repository, then run the installer in PowerShell. The installer builds
revgate. It puts the `revgate` CLI on your PATH. It installs the
`/revgate-review` and `/revgate-plan` skills. It also wires the one automatic
hook, the plan gate. You edit no paths by hand, and you run no separate npm
command.

```powershell
git clone <repo-url> revgate
cd revgate
.\install.ps1
```

There is one install route and no prompt. Each run installs the CLI, both
skills, and the global plan gate at
`%USERPROFILE%\.copilot\hooks\revgate.json`. Thus the gate covers each
repository that you work in.

```powershell
.\install.ps1 -Timeout 1800        # plan review timeout in seconds (default 3600)
.\install.ps1 -Help                # each installer switch
```

Each install copies `.github\skills\*` into `%USERPROFILE%\.copilot\skills\`.
This step makes `/revgate-review` and `/revgate-plan` available in Copilot CLI.
Run `/skills reload` after the install. The skills call the `revgate` bin, thus
each install also runs `npm install -g .` from this clone, to put that bin on
your PATH. The plan hook pins the absolute `node dist/index.js` path, and it
needs nothing on the PATH.

> If PowerShell blocks the script, you have two options. Unblock it one time
> with `Unblock-File .\install.ps1`. Or run it in a single session with
> `powershell -ExecutionPolicy Bypass -File .\install.ps1`.

### Upgrade

The installer writes a *snapshot* of the hook config. Thus a change to the hook
set does not reach an existing install until you run the installer again.

```powershell
git pull
.\install.ps1                    # it rewrites the hook file, rebuilds dist/ and the global CLI, and refreshes the skills
```

**An upgrade from 0.1.x:** revgate removed the `agentStop` diff gate. A new
installer run rewrites the hook file with only the `preToolUse` plan gate. Until
you do this, the stale hook still calls bare `revgate` at each end of a turn.
That command now exits 2 with a message that points back to this document, and
it does not open a review. To see what you have now, run
`Get-Content $env:USERPROFILE\.copilot\hooks\revgate.json`. The file must list
`preToolUse` and nothing else. Add `-SkipBuild` to rewire an existing `dist/`.
That switch skips the dependency install, `tsc`, and the global CLI install.

## Verify

```powershell
node dist\index.js review --help              # each flag
node dist\index.js review                     # a diff review against your working tree
```

The second command opens the review page directly. Use it to confirm that
revgate works before you depend on the hook. A completely clean tree has nothing
to review, thus change a file first. Add `--no-open` if you prefer to open the
printed URL yourself.

## `revgate review`

This is the on-demand entry point. It is not a hook. It reads nothing from
stdin. It writes markdown annotations to stdout, never hook JSON. And it uses
real exit codes.

```
revgate review [<refs>] [options]
```

### Scopes

The positional arguments are the same as in revdiff.

| Argument | What revgate reviews |
| --- | --- |
| *(none)* | the working tree against `HEAD`, with the untracked files |
| `<ref>` | `<ref>` against the working tree, for example `revgate review HEAD~3` |
| `<a> <b>` | `<a>` against `<b>`, for example `revgate review main feature` |
| `<a>..<b>` | the same as two refs, for example `revgate review main..feature` |
| `<a>...<b>` | `<a>` against `<b>` from their merge base |
| `--staged` | the index only; you cannot use it together with refs |

revgate adds untracked files to the working-tree scope only. A ref, a range and
the staged scope never pick them up. revgate validates each ref with
`git rev-parse` before that ref reaches `git diff`. Thus a typo is bad usage
(exit 2), not a git crash.

revgate also caps untracked *content*, thus a `dist/` that nobody ignored, or a
stray data dump, cannot stall the gate. The caps are 2 MB for one untracked
file, and 8 MB or 300 files across one review. revgate still lists a file that
is past a cap, but it shows that file unexpanded. The rendering is the same as
for a binary file, and revgate writes a warning to stderr. revgate never elides
a tracked change, and it drops nothing. A file that you cannot expand is still a
file that you can see was added.

The per-file **Staged** toggle is available in the working-tree scope and the
`--staged` scope only. The toggle applies to the working tree. Thus in a ref or
range review it reports an index state that says nothing about the commits on
the page, and a stage action from there adds content that is not in the reviewed
diff.

A path with an unresolved merge conflict shows as **Unmerged**, and its toggle
is disabled. The API answers a stage request for such a path with 409. Its index
entry holds the conflict stages, not a staged and unstaged pair. To unstage it
drops those stages: the conflict markers then stay on disk, but git no longer
calls the file conflicted, and the next commit records the markers as the
resolution. Resolve the conflict in git first.

### Options

| Flag | Meaning |
| --- | --- |
| `--staged` | Review the staged changes only |
| `-I`, `--include <path>` | Review only the paths that start with `<path>`. Repeatable |
| `-X`, `--exclude <path>` | Skip the paths that start with `<path>`. Repeatable |
| `--plan [<file>]` | Review a plan document instead of a diff |
| `-o`, `--output <file>` | Write the annotations to `<file>` instead of stdout. If revgate cannot write the file, it falls back to stdout and gives a warning, thus a captured verdict is never dropped |
| `--exit-code-on-comments` | Exit `10` when the review captured comments or requested changes |
| `--history-dir <dir>` | Save the reviews under `<dir>`. It beats `$REVGATE_HISTORY_DIR` |
| `--no-history` | Do not archive this review |
| `--no-open` | Do not open the browser automatically |
| `-h`, `--help` | Show the usage text |

`--staged`, `--no-open`, `--no-history`, `--exit-code-on-comments` and `-h` are
switches, and they take no value. `--no-history=false` is a usage error
(exit 2). It does not mean "keep the history". Omit the flag to get the default.
To accept the value and then discard it inverts the intention of the caller in
silence, and the primary caller is an agent.

A flag that *takes* a value rejects an empty one. `-o ""`, `-I ""` and
`--history-dir ""` are usage errors (exit 2). They do not mean "no output file"
or "no filter". A skill can put an unset shell variable into the command line,
for example `-o "$OUT"` or `-I "$SCOPE"`. Without this rule, that skill gets
different behaviour than it asked for, and it gets no warning.

`--include` narrows first, then `--exclude` removes from what is left. This is
the same composition that revdiff documents. Both flags match a path prefix, at
a directory boundary: `-X src/generated` drops `src/generated/g.ts`, but it
keeps `src/generated-old.ts`.

revgate matches the prefixes against **paths that are relative to the repository
root**. `git diff -- <pathspec>` matches against the current directory, but
revgate does not. Thus from `pkg/` you still write `-I pkg/lib`, not `-I lib`.
If the filters remove each changed file, revgate does not report an approval. It
prints a `NOTHING IN SCOPE` report and exits `2`, because nobody looked at
anything.

A positional argument is always a ref, never a path. `revgate review src` looks
for a commit with the name `src`, and it exits 2. Use `-I src` to scope the
review by path.

### Examples

```bash
revgate review                                    # each uncommitted change
revgate review --staged                           # what you are about to commit
revgate review HEAD~3                             # the last three commits and the working tree
revgate review main..feature                      # a branch, as a pull request shows it
revgate review main..feature --include src        # only the src/ part of it
revgate review -I src -I public -X src/generated  # the filters compose
revgate review --exit-code-on-comments            # exit 10 if there is work to do
revgate review -o review.md main..feature         # write the annotations to a file
```

### Output format

`revgate review` prints a leading section with the verdict. Then it prints one
**record** for each comment.

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

- The leading section holds the verdict of the reviewer (`APPROVED` or
  `REQUEST CHANGES`) and their summary. Thus a consumer knows the outcome
  without a parse of the records.
- Each `## ` line opens a record and names an exact location. Everything below
  it, up to the next `## ` line, is the body of that comment.
- `## path:LINE (+)` is one line on the **new** side. `## path:START-END (+)` is
  a range. `(-)` is the **old** side, before the change. `## path` alone is a
  file-level comment.
- Each continuation line in a body is indented by one space, thus a body can
  never look like a record header. The first line of a body is flush left. There
  is one exception: a first line that starts with `#` would open a bogus record,
  thus revgate indents that line too.
- `scope:` is a label for a person to read. It is not a command line that you
  can run again. Its values are `working tree vs HEAD`, `staged changes`,
  `HEAD~3 vs working tree`, or `main..feature`. revgate appends
  `[+<include> -<exclude>]` when you applied path filters.
- A plan review adds a `mode: plan` line to the leading section, and it writes
  **no** `scope:` line, because there is no diff behind it. Its records point
  into the plan document. The synthetic file always has the name `Plan`, thus
  each header reads `## Plan:<line> (+)`.
- Two more lines in the leading section mean that the review was **incomplete**.
  They appear on an ordinary `APPROVED` or `REQUEST CHANGES` report as readily
  as on the exit-2 reports below. `untracked-scan: failed` means that revgate
  could not list the new files, thus it reviewed none of them.
  `dropped-paths: <n>` means that this many changed files carry a line break in
  their path, and revgate rendered none of them. Act on the records. Then say
  that the review did not cover everything.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The review completed. The reviewer approved it, or there was nothing to review, or revgate captured comments on a run *without* `--exit-code-on-comments` |
| `10` | revgate captured comments. This code needs `--exit-code-on-comments` |
| `1` | An unexpected error, or the review stopped before the reviewer submitted a verdict |
| `2` | Bad usage. The causes are: an unknown flag; a mistyped subcommand; a value on a valueless switch; a ref that does not resolve; a scope flag alongside `--plan`; a `--plan` with no plan text behind it; `-I` or `-X` filters that removed each changed file; a working directory that is not a git repository; or an untracked-file scan that failed |

Without `--exit-code-on-comments`, **each** completed review exits `0`, whatever
the verdict. Thus pass the flag, or parse the `# revgate review:` line. Do not
read `0` as "approved".

`--plan` is strict about the plan text. A path that revgate cannot read, a file
that exists but is empty, and a bare `--plan` with no `$REVGATE_PLAN_FILE` all
exit 2. `revgate review --plan` never falls back to a diff review in silence,
because exit 0 there reads as a sign-off on a plan that nobody saw.

An interrupted review reports `# revgate review: NO REVIEW CAPTURED` and exits
1. It does not report `APPROVED` and 0. Nobody approved anything, and an agent
must not read our own failure as a sign-off by a person. A run outside a
repository reports the same banner and exits 2, for the same reason. It is a
wrong directory, not an approval.

If the scan for untracked files fails, each new file is missing from the diff.
Many turns produce new files only, and for such a turn the result is an empty
diff that otherwise reads as "there is nothing to review". revgate reports
`# revgate review: SCAN FAILED` with an `untracked-scan: failed` line instead,
and it exits `2`. It writes git's reason to stderr. Unlike the other exit-2
causes, this one is an environment failure rather than a bad command line, thus
a second run is reasonable. If revgate did review tracked files, the verdict of
the person stands, the same `untracked-scan: failed` line rides along on the
report, and the review page carries a banner that says that new files are
missing. Thus neither the reviewer nor the report claims to cover the whole
turn.

revgate never renders a changed file whose path contains a line break, because
such a path splices forged `## path:line` records into the annotation output. If
that leaves nothing to review, the same rule applies: revgate reports
`# revgate review: PATHS DROPPED` with a `dropped-paths:` count and exits `2`,
rather than approves a diff that those files never reached. If revgate did
review other files, the verdict stands, and the count rides along as a
`dropped-paths:` header line. Thus the report never claims to cover more than it
does.

Anything that is not `revgate review …` or `revgate copilot-plan` is bad usage,
exit 2. This covers a mistyped subcommand, thus a typo such as "reviw" does not
quietly review a git ref of that name. It also covers review flags with the
subcommand dropped, and bare `revgate`. Bare `revgate` was the removed
`agentStop` diff gate. It now prints a pointer to a new installer run, and it
does not open a review. A typo must never be able to forge a clean review, and a
stale hook must fail loudly rather than gate in silence.

The hook path is deliberately different. `copilot-plan` always exits 0 and
speaks decision JSON, because Copilot fails a `preToolUse` hook **closed** on a
non-zero exit.

### Review history

revgate archives each review that captured something — a comment, or a
request-changes verdict — as markdown. It does this on both paths, the skill and
`copilot-plan`:

```
<historyDir>/<repo-name>/<timestamp>.md
```

`<historyDir>` is `--history-dir`, else `$REVGATE_HISTORY_DIR`, else
`~/.revgate/history`. `<repo-name>` is the basename of the git toplevel, and it
is `no-repo` outside a repository. The file starts with YAML frontmatter: date,
repo, mode, session, scope and branch. Then come the same annotation records as
above. Thus a review survives a hook timeout, a closed terminal, or an agent
that ignored it.

revgate does not archive an approval that has no comments. A history failure
never fails a review: revgate warns to stderr and continues, thus a read-only
home directory cannot wedge a gate. Use `--no-history` to opt out for one run.

### Themes

The review page ships five built-in colour themes. You pick one from the
dropdown in its header.

| Theme | Kind |
| --- | --- |
| Dark Modern | the default dark palette |
| Light Modern | the default light palette |
| Monokai | dark |
| Solarized Light | light |
| Dracula | dark |

The default is **System**. It is a real choice, and not the absence of one. It
follows the OS through `prefers-color-scheme`, and it resolves to Dark Modern or
to Light Modern. It also resolves again while the page is open: flip your OS
between light and dark in the middle of a review, and the page follows without a
reload.

revgate saves your pick server-side, in:

```
~/.revgate/config.json
```

```json
{ "theme": "dracula" }
```

The pick has to live on disk rather than in the browser. The review server binds
a random port, thus each run is a distinct origin with its own empty
`localStorage`. A store in the browser forgets the choice the moment the review
closes, every time.

`$REVGATE_CONFIG_DIR` overrides **the directory that holds `config.json`**, and
the file inside it always has that name. This shape is deliberately not the same
as `$REVGATE_HISTORY_DIR`, which names the history directory *itself*:

| Variable | What it names | The resulting path |
| --- | --- | --- |
| `$REVGATE_CONFIG_DIR` | the directory that holds `config.json` | `<dir>/config.json` |
| `$REVGATE_HISTORY_DIR` | the history directory itself | `<dir>/<repo>/<timestamp>.md` |

Thus the defaults are `~/.revgate` and `~/.revgate/history`. Do not give
`$REVGATE_CONFIG_DIR` a path with the shape of the history path.

Theme handling never fails a review. A missing config file is the normal first
run, and revgate is silent about it. Four conditions make revgate fall back to
`system`: a config that it cannot read, a malformed config, a saved id that this
version does not know, and a home directory that it cannot write. The last three
also warn to stderr. A save is best-effort in the same spirit: revgate reports a
failed write to stderr only, because an error answer makes the page undo a
change that you can plainly see. If the page cannot load the themes at all, it
renders without the picker rather than not at all. A cosmetic subsystem must not
be able to wedge a gate.

revgate ships the five built-in themes only. The "Design notes" section says why
user-authored theme files were deferred.

## Plan review

revgate can also gate the agent *before* it writes code. It then reviews the
**plan** that the agent proposes, rather than the resulting diff. Approve the
plan, and the agent proceeds with it. Request changes, and your feedback becomes
the next prompt of the agent, thus the agent revises the plan first.

There are two ways in, and they match the two ways to run revgate:

- **Automatic** — Copilot's `preToolUse` hook, through `revgate copilot-plan`.
  This is the one automatic gate of revgate, and a normal install wires it.
- **On demand** — `revgate review --plan <file>`, which is the `/revgate-plan`
  skill. Use it when you are not in Copilot plan mode at all, when the agent
  wrote the plan to a file as ordinary work, or when you want a second look at
  an approved plan.

How the hook works:

1. In Copilot CLI, `Shift+Tab` enters plan mode. The agent drafts a plan, then
   it calls the `exit_plan_mode` tool to leave plan mode.
2. `preToolUse` fires *before* that tool runs. The hook has no matcher and it
   fires for every tool, thus `revgate copilot-plan` self-filters: it passes any
   other tool straight through, with `permissionDecision: allow`.
3. For `exit_plan_mode`, revgate resolves the plan text and opens the review
   page. It reads `~/.copilot/session-state/<sessionId>/plan.md` first, because
   Copilot writes the plan there (`$COPILOT_HOME` overrides `~/.copilot`).
   Otherwise it reads the plan from the hook payload (`toolArgs.plan` or
   `tool_input.plan`). A payload that names no session prefers its own inline
   plan, because without a session id the newest `plan.md` on disk can belong to
   a different session or a different repository. Only a payload that carries
   neither a session id nor an inline plan falls back to that cross-session
   scan.
4. **Approve** gives `permissionDecision: allow`, the tool then runs, and the
   agent proceeds. **Request changes** gives `permissionDecision: deny`, and
   revgate hands your review back as the reason, thus the agent revises the
   plan.

The plan hook **fails open**: if revgate cannot find plan text, or is
interrupted, or errors, it allows the tool through rather than blocks the agent.

The review page, the line comments and the approve or request-changes verdict
are identical to a diff review. Each plan line takes a comment, and revgate
quotes your notes back to the agent.

`revgate review --plan <file>` reviews a plan file and prints annotations, which
is what the skill needs. A bare `--plan` with the `REVGATE_PLAN_FILE` variable
set does the same. The hook needs no file at all: it resolves the plan from
Copilot's own session state, as above.

## Uninstall

```powershell
.\install.ps1 -Uninstall           # it removes the global hook AND the skills
```

`-Uninstall` removes what the install wrote: the global hook and the skills. A
second run is a no-op. npm owns the globally installed CLI, and the uninstaller
leaves it in place. Remove it with `npm uninstall -g revgate`. The uninstaller
reminds you.

## Develop

```bash
npm install            # it also builds, through the `prepare` script; a type error fails the install
npm run build          # it compiles the TypeScript to dist/
npm test               # the node:test suite through tsx; it needs Node 21 or later — see below
npm run dev -- review  # it runs the UI against your working tree without a build
```

revgate itself runs on Node 18 or later, but `npm test` needs **Node 21 or
later**. The test script passes a glob to `node --test`, and the runner expands
that glob rather than the shell. Everything else in this list works on Node 18.

`src/` groups the code by concern, and each package holds one of them:

| Package | Concern |
| --- | --- |
| `src/cli/` | argv, the help text, and the body of each command |
| `src/git/` | each call to git, the scopes, the untracked budget, and the index |
| `src/review/` | the diff parser, the plan, the feedback, and the report |
| `src/server/` | the local review server and its HTTP guards |
| `src/integrations/` | the clients for other products; today Copilot only |
| `src/store/` | the history files, the palettes, and the config file |
| `src/shared/` | the shared types and the stderr logger |

`src/index.ts` stays at the root of `src/` and it dispatches only. `test/` has
the same shape as `src/`. `public/` holds `index.html` for the markup, `app.css`
for the style, and `app.js` for the page script. `agents.md` lists each module,
and it holds the rules that keep this structure honest.

`.github/skills/` is the only skill tree, and the installer copies it without a
change into `%USERPROFILE%\.copilot\skills\`. `hooks/revgate.json` is a
reference template. The installer generates a copy with the correct absolute
path to the `dist/index.js` of this clone, and it writes that copy only to the
global `%USERPROFILE%\.copilot\hooks\`. The installer no longer writes
`.github/hooks/`, but that directory stays gitignored: a hand-copied template
there pins the path of one machine, and to commit it hands every other clone a
hook that cannot run. The template and the generated copy both wrap the
`preToolUse` command in an existence check on `dist/index.js`, because that hook
fails **closed**. Without the check, a clone that moved, a cleaned `dist/`, or a
mistyped path denies every tool call in every session, until somebody finds the
JSON and edits it by hand.

`test/docs.test.ts` guards this file and `agents.md` the same way: each flag in
`--help` must appear in the README, and each quoted revgate command line here
must parse through `parseArgs`. Update the documents in the same commit as the
code.

Three rules to know before you change anything:

- **stdout is a contract.** Each log line goes to stderr
  (`src/shared/log.ts`), because Copilot parses stdout. Do not widen what
  reaches stdout without an explicit mode flag.
- **The hook fails open.** Each error path of `revgate copilot-plan` writes an
  explicit `allow` and exits 0. Only `revgate review` may exit non-zero.
- **Comments are moderate, and `npm test` measures them.** Keep a one-line
  JSDoc on each exported symbol in `src/`. Add a short "why" note only where the
  code is not obvious. `test/comments.test.ts` fails the build if a file in
  `src/` or in `test/` goes above 20% comment lines, or if a comment carries
  narrative or history. The full reasoning belongs in the Rules of `agents.md`,
  not in the code.

## Design notes: what we took from revdiff

The on-demand invocation model comes from
[umputun/revdiff](https://github.com/umputun/revdiff). revdiff is a standalone
AI code reviewer, and agents drive it through skills and slash commands. revgate
takes these parts of it: the positional ref scopes and `--staged`; `--include`
and `--exclude` and their narrow-then-remove composition; the
`## path:LINE (+)` annotation record format, with continuation lines that are
indented by one space; `-o` and `--output`; exit code `10` for "revgate captured
comments"; and the `<historyDir>/<repo>/<timestamp>.md` history.

The overall posture comes from revdiff too. revdiff is manual-first, and its one
hook-driven exception is automatic plan review, in the `revdiff-planning`
plugin. Since 0.2.0 revgate has the same shape: the `agentStop` diff gate that
once fired at each end of a turn is gone, and the `preToolUse` plan gate is the
only thing that runs unasked.

revgate adopted two things in a **reduced** form:

- **Themes**, as the five built-ins above and nothing else. The themes of
  revdiff are a TUI feature. The palettes port to a browser page, but the loader
  for user-authored theme files does not — see below.
- **A config file**, which holds exactly one key. This item was on the deferred
  list until the themes landed. The reasoning was that the flags,
  `$REVGATE_HISTORY_DIR`, `$REVGATE_PLAN_FILE` and `$COPILOT_HOME` covered
  everything that such a file would hold. That reasoning was wrong for anything
  that the *page* chooses: the random port makes each run a fresh browser
  origin, thus no browser-side store can persist a preference across reviews.
  `~/.revgate/config.json` exists for precisely that gap, and it holds only what
  falls into it.

revgate deliberately did **not** adopt these, because it is a browser page
rather than a TUI, and because a person is the reviewer rather than an LLM:

- the terminal UI, the vim motions and the blame view
- Mercurial and Jujutsu support
- `--stdin` and `--only`
- user-authored themes, which drop a JSON theme into `~/.revgate/themes/`. The
  file format is the small part. The bootstrap around it is what makes the
  feature usable: revgate must dump a valid starting file, validate a theme
  before it adopts it, and ship examples to copy. Without that, a user
  hand-authors a theme against one README example and sees a validation failure
  only as a stderr warning that nobody reads. It is also the one place where
  this feature has to start policing colour *values*, because a hand-written
  `url(…)` fires an outbound request from a page that is otherwise deliberately
  network-free.

revgate keeps what revdiff does not have: a plan gate that is native to Copilot,
and a browser review page where a person leaves the comments.
