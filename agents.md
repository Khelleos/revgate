# revgate: Agents Guide

revgate is a human-in-the-loop review gate for GitHub Copilot. It opens a local
web page. On that page a person reviews a diff or a plan, in the way that they
review a GitHub pull request. revgate then gives the comments back to the agent.

revgate is manual-first, with one automatic exception. The difference is
important when you change the code.

- **The command and the skills (the default).** You start a review with
  `revgate review`. The `/revgate-review` and `/revgate-plan` skills also start
  it. It writes markdown annotations to stdout. It uses real exit codes: `0`,
  `10` with `--exit-code-on-comments`, `1`, and `2`.
- **The plan hook (the exception).** The agent's `preToolUse` hook calls
  `revgate plan`. It writes the agent's permission decision to stdout as JSON.
  This path must **always exit 0**. It is the only hook. Release 0.2.0
  removed the `agentStop` diff gate. A bare `revgate` is now a usage error
  (exit 2), not a hook entry point.

## Modules

Each package owns one concern, and each file inside it owns one subject. A new
package must also get a line here.

```
src/revgate/
  __main__.py     dispatch only, plus the outermost fail-open handler
  cli/            the argv grammar, the Click shell, the byte-exact --help, one file per command
  git/            every git call, the scopes, the untracked budget, the index
  review/         the diff parser, the plan model, the feedback prompt, the report and its exit code
  server/         the review server, its HTTP guards, the submission normalizer
  integrations/   clients for other products; today Copilot's per-session plan.md only
  store/          the history files, the palettes, ~/.revgate/config.json
  shared/         the shared types, the stderr logger, the stdout discipline, the JSON wire format
  public/         the review page (index.html, app.css, app.js), shipped as package data
```

`tests/` has the same shape. The suite-wide tests stay at its root:
`test_main.py` spawns the real process, and `test_architecture.py` holds the two
import rules the whole git layer depends on.

`tests/helpers/` holds the shared fixtures: a throwaway git repository
(`repo.py`), a `DiffScope` and a hostile `~/.gitconfig` (`scope.py`), the
`DiffFile`/`LineComment`/`ReviewSubmission` builders (`review.py`), a real
waitress driven over `http.client` and raw sockets (`server.py`), and an entry
point spawned with its output kept as **bytes** (`cli.py`). Import a fixture
from here; do not build a second one.

## Commands

```bash
uv sync --all-groups   # it creates .venv and installs the runtime and dev groups
uv run ruff check      # lint
uv run ruff format     # format
uv run mypy            # types, in strict mode
uv run pytest          # the whole suite
uv run revgate review  # the UI against your working tree, straight from the checkout
```

The first four are the gate: each change comes with tests, and all four must be
green before you go on. A quick manual test: `uv run revgate review --help`,
then `uv run revgate review --no-open`.

## Rules

- **stdout is a contract.** Each log line goes to stderr, because Copilot reads
  stdout. Do not put more on stdout without an explicit mode flag.
  `plan` writes exactly one `PermissionDecision`. `review` writes only
  annotations, or nothing when you give it `--output`.
- **The hook must fail open.** Each error path of `plan` writes an
  explicit `allow` and exits 0. A non-zero exit makes `preToolUse` fail
  *closed*. Only `revgate review` can exit with a non-zero code. Each invocation
  that is not the hook is a `review` invocation. A bad one exits 2, and it must
  never write a hook-shaped message to stdout.
- **An absent verdict is never an approval.** `review_report` in
  `review/report.py` holds this rule, because APPROVED with exit 0 is a clean
  bill of health for code that nobody saw. An interrupted review is the
  *absence* of a decision: exit 1. Four conditions are exit 2, being bad usage
  or an environment error rather than "there is nothing to review":

  - revgate runs outside a repository;
  - the `-I` or `-X` filters removed each changed file;
  - the untracked scan failed and the tracked diff is empty;
  - each file in the diff had an unsafe path and revgate dropped it.

  Each of the four applies only when there is no verdict, because a plan review
  also opens the page with an empty file list, and discarding a decision a
  person just wrote is the same error in the opposite direction. Only a truly
  empty diff is a correct "approve, there is nothing to act on". A verdict still
  carries the `untracked-scan: failed` and `dropped-paths:` header lines, which
  name what the person did not see. With `-o <file>` the report is all the agent
  reads, so a warning on stderr substitutes for none of this.
- **The annotation record format is a contract.** The report starts with
  `# revgate review: <VERDICT>`, then the `mode:`, `scope:`, `branch:`, `files:`
  and `comments:` header lines, then one `## <path>:<start>-<end> (+)` record
  per comment with its body below. `(-)` marks the old side; a bare `<path>`
  marks a file-level comment. Each continuation line starts with one space, and
  so does a first line beginning with `#`, so a body can never open a false
  record. A diff has two line numberings per hunk, and the `(+)`/`(-)` marker is
  the only thing that says which one applies. `location_header` in
  `review/feedback.py` writes the location for the annotations and for the hook
  text alike, so the two can never describe one comment differently.
- **A path with a line break never reaches a renderer.** Every stage after the
  parser works on lines (`## <path>:<line>`, `### <path>`), so such a path
  splices false records into the annotations and the feedback prompt — a review
  directive against a file nobody commented on. `parse_unified_diff` drops
  tracked files and reports them through `on_drop`; `collect_diff` drops
  untracked ones; `untracked_file_diff` refuses a symlink whose target holds a
  line break; `describe_scope` flattens the `-I`/`-X` values, because the report
  writes that label into its `scope:` header unchanged. Every drop is counted
  and none is silent — see the verdict rule above.
- **Untracked content: cap how much, never what, and never drop it.**
  `untracked_file_diff` lists a file it cannot expand rather than omitting it,
  whether it is past a size cap, past the review budget, or unreadable — a file
  that leaves the review is a file the reviewer approved without seeing. It
  calls `lstat`, not `stat`, and reads the mode *before* the budget test:
  following a link puts content into the review that is not in the repository
  (an untracked `config -> ~/.aws/creds` lands its secrets in
  `~/.revgate/history`), and `stat` on a link to a FIFO or `/dev/zero` reports
  size 0, which passes every ceiling before the read blocks forever or eats all
  memory. An elided link is still shown, with mode `120000`. The ceilings are
  per review, not per file, because every inlined byte exists three times: the
  read buffer, the line objects of `parse_unified_diff`, and the JSON sent to
  the browser. `filter_files` runs *after* this, so `-I`/`-X` cannot reduce the
  work — do not move expansion behind the filters to make it cheaper, the budget
  is what bounds it.
- **`git status` has two traps, and a conflict is neither of them.** A rename or
  copy record keeps its source path in the *next* NUL field, and either column
  can hold the `R` or the `C`, so revgate tests both; unskipped, that source path
  becomes its own record whose bogus key can overwrite a real one. One path can
  also carry a tracked and an untracked record together (`git rm --cached x`),
  and git writes the `??` record last — the tracked one describes the index, so
  it wins. Separately, `UU`, `AA`, `DD` and every pair containing a `U` mark
  conflict *stages*, not half-staged content: read as `partial`, the page offers
  an unstage, `git reset` drops those stages, and the next commit records the
  conflict markers as the resolution. So `get_stage_states` reports `unmerged`
  and the stage routes answer 409. A path is a plain `dict` key here, so
  `__proto__` needs no guard in Python — the page's own maps still use
  `Object.hasOwn` and `Object.create(null)`, and they must keep them.
- **`---` and `+++` are headers only outside a hunk.** Inside a hunk body the
  tag character shifts content one column right, so a deleted `-- ` line (a
  comment in SQL, Lua or Haskell) arrives as `--- …` and an added `++ ` line as
  `+++ …`. Read as a path header, three things go wrong: the line disappears
  from the review, that side's line numbers are off by one, and the `+++` case
  overwrites `path` — the identity key for the staging allow-list and for the
  annotation records.
- **The review server is a trust boundary.** It listens on `127.0.0.1` on a
  random port and rejects two kinds of request before routing, so every new
  route inherits both guards: a `Host` that is not loopback on our port (a DNS
  rebind otherwise reads the whole diff), and a cross-origin POST.
  `normalize_submission` and `normalize_comment` coerce every submission at that
  same entry point, because the renderers below read `body`, `file` and
  `start_line` untested and a raise inside the fail-open handler reports a forged
  *approval*. Three more invariants bind every route. Each answer carries
  `content-security-policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`,
  because in a frame one stray click becomes a same-origin approval that passes
  the guards. Each body is capped by Flask's `MAX_CONTENT_LENGTH` at
  `MAX_BODY_BYTES` with a 413, because this process blocks a hook and an
  unbounded body stalls the turn. And each index write, together with the
  `get_stage_states` read beside it, runs inside a module-level `threading.Lock`,
  because `.git/index.lock` makes a concurrent `git add` or `git reset` fail
  outright.
- **Every git call goes through `git()` or `git_diff()`.** Both live in
  `git/exec.py` and stay inside the `git/` package: no module outside it may
  import them, and no module outside `git/exec.py` and `server/browser.py` may
  even import `subprocess`. `tests/test_architecture.py` walks the AST of every
  module and enforces both. `git()` injects `HARDENED_CONFIG` —
  `core.quotePath`, `diff.relative`, `diff.noprefix`, `diff.mnemonicPrefix`,
  `diff.srcPrefix`, `diff.dstPrefix`, `status.showUntrackedFiles` — because any
  of these inherited from the reviewer's own `~/.gitconfig` renames files in the
  review or removes them from it. `git_diff()` adds `--no-ext-diff`, the one
  setting `-c` cannot turn off: an external driver makes git exit 0 with output
  the parser reads as an empty diff, and the gate then reports APPROVED for
  changes nobody saw. `review/diff.py` still unquotes what git quotes anyway (a
  `"` or a control character in a name), because every path must reach
  `filter_files` and the annotation renderer exactly as it is on disk.
- **History and theme config are best-effort and never raise.** `save_history`
  warns and continues. So does `store/theme_config.py`: a bad config file or an
  unwritable `$REVGATE_CONFIG_DIR` (default `~/.revgate`) warns and falls back to
  `system`, and `POST /api/theme` answers 200 even after a failed write, because
  the page has already repainted and an error would make it undo a change the
  user can see. `write_theme_config` rewrites the whole file, which is correct
  only while `theme` is the only key, and holds a module-level `threading.Lock`,
  because the picker posts once per `change` event and two unserialized writes
  race for the same temporary path and rename.
- **The palettes and the page CSS are one set.** `PALETTE_KEYS` in
  `store/palettes.py` is the exact property set every built-in theme must define,
  and nothing merges over a base. Both `:root` blocks in `public/app.css` are
  hand-made copies of Dark Modern and Light Modern for the first paint, plus
  `--mono`, the font stack, which is not themeable. A new custom property or
  colour must land on both sides. Nothing checks this, so re-read `app.css` by
  eye when you retune a built-in.
- **Tests use a real git repository, never the user's, and a real process for
  the contracts.** Every git-touching test builds a throwaway repository with the
  `make_repo` fixture, which pins `user.name`/`user.email`, turns off signing and
  `core.autocrlf`, points `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM` and
  `core.hooksPath` at paths that never exist, and starts on `main`. An autouse
  `isolate_home` fixture in `tests/conftest.py` redirects `REVGATE_HISTORY_DIR`,
  `REVGATE_CONFIG_DIR` and `COPILOT_HOME` for every test, so a new one cannot
  forget; no test may run the installer against the real `%USERPROFILE%`.
  `tests/test_main.py` spawns `[sys.executable, "-m", "revgate", …]` and asserts
  on stdout, stderr and the exit code — the only honest way to test the three
  output contracts — and every byte-exact assertion there compares **bytes**,
  since a string comparison passes on a build that writes CRLF or cp1252. Logic
  that needs a unit test goes in an importable module: the report and exit-code
  choice is `review_report`, each command body is in `cli/`, and `__main__.py`
  keeps only the dispatch and does not run on import.
- **The skill tree is the source; the installed hook files are not.**
  `assets/skills/` is the only skill tree, copied unchanged by `install.ps1`
  into `%USERPROFILE%\.copilot\skills\`. The generated hook is written only to
  `%USERPROFILE%\.copilot\hooks\`, with an absolute path to *this* clone;
  `assets/hooks/revgate.json` is a reference template, never a hook any clone
  runs as-is, because a copy carrying another machine's path gives every other
  clone a `preToolUse` hook that cannot run — and that hook fails closed. Both
  copies keep the existence check around the `preToolUse` command for the same
  reason.
- **`pyproject.toml` holds two invariants a refactor breaks in silence.**
  `[project.scripts] revgate` must stay `revgate.__main__:main`, because
  `install.ps1` resolves that console script and writes its absolute path into
  the generated `preToolUse` hook. And the wheel must keep shipping
  `src/revgate/public/`, or an installed build serves a 404 for every asset and
  the review page is blank.
- **Documentation moves in the same commit as the code.** Each `--help` flag must
  be in the README, each command line a SKILL.md quotes must parse, and this file
  must list each `src/revgate/` package. Nothing checks these automatically.
- **Comments are moderate.** Keep a one-line docstring on each public symbol. Add
  a short "why" note only where the code is not obvious, or where it guards an
  invariant. Write no narrative and no history. Do not restate the code. The full
  reasoning is in these Rules, and that is why they are long.
- Use absolute imports (`from revgate.git.exec import …`); Ruff's `TID` rules ban
  the relative form. Spawn git with `subprocess.Popen` and an argv list, never a
  shell. Keep the runtime dependencies to Click, Flask and waitress, each pinned
  to a major version.
