# revgate: Agents Guide

revgate is a human-in-the-loop review gate for GitHub Copilot CLI. It opens a
local web page. On that page a person reviews a diff or a plan, in the way that
they review a GitHub pull request. revgate then gives the comments back to the
agent.

revgate is manual-first, with one automatic exception. The difference is
important when you change the code.

- **The command and the skills (the default).** You start a review with
  `revgate review`. The `/revgate-review` and `/revgate-plan` skills also start
  it. It writes markdown annotations to stdout. It uses real exit codes: `0`,
  `10` with `--exit-code-on-comments`, `1`, and `2`.
- **The plan hook (the exception).** Copilot's `preToolUse` hook calls
  `revgate copilot-plan`. It writes Copilot's permission decision to stdout as
  JSON. This path must **always exit 0**. It is the only hook. Release 0.2.0
  removed the `agentStop` diff gate. A bare `revgate` is now a usage error
  (exit 2), not a hook entry point.

## Modules

Each file has one subject. The tree below is the full contents of `src/`.
`test/docs.test.ts` compares the tree with the disk, thus a new module must also
get a line here.

```
src/
  index.ts              the entry point; it dispatches only
  cli/
    args.ts             parseArgs(argv); it gives one command and its options
    help.ts             the --help template and helpText()
    review-command.ts   runReviewCommand, reviewDiff, resolvePlan
    plan-hook.ts        runCopilotPlanHook, gatePlan, readHookPayload, emitPermission
  git/
    exec.ts             git() and gitDiff(), the only place that starts git; HARDENED_CONFIG, gitErrorMessage, hasHead, isGitRepo, findRepoRoot, repoRoot
    scope.ts            DiffScope, ScopeError, describeScope, verifyArity, verifyRef, filterFiles
    untracked.ts        untrackedFileDiff, looksBinary, the MAX_UNTRACKED_* budgets
    collect.ts          collectDiff(cwd, scope) and RepoDiff
    staging.ts          getStageStates and setStaged
  review/
    diff.ts             the unified-diff parser
    plan.ts             planToFiles and planTitle; a plan becomes a synthetic one-file diff
    feedback.ts         buildDecision, groupCommentsByFile, locationHeader
    annotations.ts      renderAnnotations and the other renderers; the contract the agent reads
    report.ts           reviewReport, reviewExitCode, hasFindings
  server/
    index.ts            startReviewServer, the routes, ReviewContext, ServerHandle
    http.ts             json, readBody, BodyTooLarge, MAX_BODY_BYTES, MIME, isLoopbackAuthority, setFrameHeaders
    normalize.ts        normalizeComment and normalizeSubmission
    browser.ts          openBrowser; it never throws
  integrations/
    copilot.ts          it finds Copilot's per-session plan.md
  store/
    history.ts          saveHistory; it writes <historyDir>/<repo>/<timestamp>.md
    palettes.ts         Theme, SYSTEM_THEME_ID, PALETTE_KEYS, BUILTIN_THEMES, isKnownThemeId
    theme-config.ts     ~/.revgate/config.json; configDir, readThemeConfig, writeThemeConfig, listThemes
  shared/
    log.ts              log and warn; they write to stderr only
    types.ts            the shared types
```

`test/` has the same shape as `src/`. The suite-wide tests stay at its root:
`index.test.ts`, `docs.test.ts`, `skills.test.ts`, `comments.test.ts`,
`package.test.ts` and `install.test.ts`.

`test/helpers/` holds the shared fixtures. `repo.ts` builds a throwaway git
repository. `scope.ts` builds a `DiffScope`, and `withHostileGitConfig` runs a
body under a hostile `~/.gitconfig`, which is what proves the `HARDENED_CONFIG`
rule below. `review.ts` builds the `DiffFile`, `LineComment` and
`ReviewSubmission` fixtures that the renderer tests share. `docs.ts` pulls
`revgate …` command lines out of markdown. `tree.ts` walks a directory tree, and
it is the one walker: four copies of it drift, and a fix to one is a fix that
the others miss. Import a fixture from here; do not build a second one.

`public/` holds three files: `index.html` for the markup, `app.css` for the
style, and `app.js` for the page script.

## Commands

```bash
npm install            # it installs and it builds (prepare → tsc); a type error fails the install
npm run build          # tsc writes to dist/
npm test               # node:test through tsx; it needs Node 21 or later, because node --test expands the glob
npm run dev -- review  # the UI against your working tree, with no build
```

A quick manual test: run `node dist/index.js review --help`, then run
`node dist/index.js review --no-open`.

## Rules

- **stdout is a contract.** Each log line goes to stderr, because Copilot reads
  stdout. Do not put more on stdout without an explicit mode flag.
  `copilot-plan` writes exactly one `PermissionDecision`. `review` writes only
  annotations, or nothing when you give it `--output`.
- **The hook must fail open.** Each error path of `copilot-plan` writes an
  explicit `allow` and exits 0. A non-zero exit makes `preToolUse` fail
  *closed*. Only `revgate review` can exit with a non-zero code. Each
  invocation that is not the hook is a `review` invocation. A bad one exits 2.
  It must never write a hook-shaped message to stdout.
- **An absent verdict is never an approval.** `reviewReport` in
  `src/review/report.ts` holds this rule. Each report that has no verdict exists
  for one reason: APPROVED with exit 0 there is a clean bill of health for code
  that nobody saw. An interrupted review is the *absence* of a decision, thus it
  is exit 1. Four other conditions are exit 2: revgate runs outside a
  repository; the `-I` or `-X` filters removed each changed file; the untracked
  scan failed and the tracked diff is empty; each file in the diff has an unsafe
  path and revgate dropped it. Each of the four is bad usage or an environment
  error. None of them is "there is nothing to review". Each of the four applies
  only when there is no verdict, because a plan review also opens the page with
  an empty file list. To discard a decision that a person just wrote is the same
  error in the opposite direction. Only a truly empty diff is a correct
  "approve, there is nothing to act on". With `-o <file>` the report is all that
  the agent reads, thus a warning on stderr is not a substitute for any of this.
  A verdict also carries the `untracked-scan: failed` and `dropped-paths:`
  header lines, which name what the person did not see.
- **The annotation record format is a contract.** The report starts with
  `# revgate review: <VERDICT>`. Then come the `mode:`, `scope:`, `branch:`,
  `files:` and `comments:` header lines. Then comes one
  `## <path>:<start>-<end> (+)` record for each comment, with the body of that
  comment below it. `(-)` marks the old side. A bare `<path>` marks a file-level
  comment. Each continuation line starts with one space, and a first line that
  starts with `#` also starts with one space. Thus a body can never open a false
  record. `locationHeader` in `src/review/feedback.ts` writes the location for
  the annotations and for the hook text, thus the two can never describe one
  comment differently. A diff has two line numbers for each hunk, and the `(+)`
  or `(-)` marker is the only thing that says which one applies.
- **A path with a line break never reaches a renderer.** Each stage after the
  parser works on lines (`## <path>:<line>`, `### <path>`). Such a path splices
  false records into the annotations and into the feedback prompt. The result is
  a review directive against a file that nobody commented on.
  `parseUnifiedDiff` drops tracked files and reports them through `onDrop`.
  `collectDiff` drops untracked files. `untrackedFileDiff` refuses a symlink
  whose target holds a line break. `describeScope` flattens the `-I` and `-X`
  values, because the report writes that label to its `scope:` header without a
  change. revgate counts each drop, and no drop is silent: see the verdict rule
  above.
- **Untracked expansion controls how much, never what.** `untrackedFileDiff`
  calls `lstat`, not `stat`, and it reads the mode *before* the budget test. To
  follow a link puts content into the review that is not in the repository: an
  untracked `config -> ~/.aws/creds` then puts its secrets into
  `~/.revgate/history`. Also, `stat` on a link to a FIFO or to `/dev/zero`
  reports size 0. That size passes each ceiling, and the read then blocks
  forever or grows until the memory is full. revgate still shows a link that the
  budget elides, with mode `120000`.
- **`git status` output has two traps.** A rename or copy record keeps its
  source path in the *next* NUL field, and either column can hold the `R` or the
  `C`, thus revgate tests both. If revgate does not skip that field, the source
  path becomes its own record, and that record makes a key that can overwrite a
  real one. Also, one path can have a tracked record and an untracked record
  together (`git rm --cached x`), and git writes the `??` record last. The
  tracked record describes the index, thus the tracked record wins.
- **A conflict is not a staged/unstaged split.** `UU`, `AA`, `DD` and every pair
  with a `U` in it mark conflict *stages*, not content that is half staged.
  Without `isUnmerged` they read as `partial`, the page then offers an unstage,
  and `git reset` drops those stages. The next commit then records the conflict
  markers as the resolution. Thus `getStageStates` reports `unmerged`, and the
  stage routes answer 409 for such a path. That map also uses
  `Object.create(null)`, because a path is a key: `__proto__` on a plain object
  is swallowed, and the guard would then never see the `unmerged` state.
- **`---` and `+++` are headers only outside a hunk.** Inside a hunk body the
  tag character moves the content one column to the right. Thus a deleted `-- `
  line (a comment in SQL, Lua or Haskell) arrives as `--- …`, and an added `++ `
  line arrives as `+++ …`. If the parser reads such a line as a path header,
  three things go wrong. The line disappears from the review. The line numbers
  of that side are wrong by one. And the `+++` case overwrites `path`, which is
  the identity key for the staging allow-list and for the annotation records.
- **History is best-effort.** `saveHistory` never throws. It writes a warning
  and it continues.
- **Theme config is also best-effort, and it has one key.** Nothing in
  `src/store/theme-config.ts` throws. A bad config file or an unwritable
  `$REVGATE_CONFIG_DIR` (default `~/.revgate`) gives a warning, and the theme
  becomes `system`. `POST /api/theme` answers 200 even after a failed write,
  because the page has already repainted and an error answer makes the page undo
  a change that the user can see. `writeThemeConfig` writes the whole file
  again, which is correct only while `theme` is the only key. It also puts each
  call into a module-level queue, because the picker posts one time for each
  `change` event, and two unqueued writes race for the same temporary path and
  rename.
- **The palettes and the page CSS are one set.** `PALETTE_KEYS` in
  `src/store/palettes.ts` is the exact property set that each built-in theme
  must define, and nothing merges over a base. `test/store/palettes.test.ts`
  reads both `:root` blocks out of `public/app.css`. It asserts that their keys
  are equal to `PALETTE_KEYS`, plus `--mono`, which is the font stack and is not
  themeable. It also asserts that their values are equal to Dark Modern and
  Light Modern. Those two blocks are hand-made copies for the first paint, thus
  a new custom property or a new colour must land on both sides, or `npm test`
  fails.
- **The review server is a trust boundary.** It listens on `127.0.0.1` on a
  random port. It rejects two kinds of request before it routes them, thus each
  new route gets both guards. It rejects a request whose `Host` is not loopback
  on our port, because a DNS rebind can otherwise read the whole diff. It also
  rejects a cross-origin POST. `normalizeSubmission` and `normalizeComment`
  coerce each submission at that same entry point: the renderers below them read
  `body`, `file` and `startLine` without a test, and a throw inside the
  fail-open handler reports a forged *approval*. A new route also inherits three
  more invariants, and it must not opt out of them. Each answer carries
  `content-security-policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`,
  because in a frame one stray click becomes a same-origin approval, and a
  same-origin request passes the guards. Each request body goes through
  `readBody`, with a limit of `MAX_BODY_BYTES` and a 413 answer, because this
  process blocks a hook and an unbounded body stalls the turn. And each write to
  the index, together with the `getStageStates` read beside it, runs inside
  `serializeIndexWork`, because `.git/index.lock` makes a concurrent `git add`
  or `git reset` fail outright.
- **Each git call goes through `git()` or `gitDiff()`.** Both are in
  `src/git/exec.ts` and both stay inside the `src/git/` package. No module
  outside that package can import them, and no module can call
  `execFile("git", …)` at all. `git()` injects `HARDENED_CONFIG`:
  `core.quotePath`, `diff.relative`, `diff.noprefix`, `diff.mnemonicPrefix`,
  `diff.srcPrefix`, `diff.dstPrefix` and `status.showUntrackedFiles`. If one of
  these comes from the reviewer's own `~/.gitconfig`, it renames files in the
  review or it removes them from the review. `gitDiff()` also adds
  `--no-ext-diff`, because `diff.external` is the one setting that `-c` cannot
  turn off. An external driver makes git exit 0 with output that the parser
  reads as an empty diff, and the gate then reports APPROVED for changes that
  nobody saw. `src/review/diff.ts` still unquotes what git quotes anyway: a `"`
  or a control character in a name. Each path must reach `filterFiles` and the
  annotation renderer exactly as it is on disk.
- **Untracked content has a limit, but revgate never drops it.**
  `untrackedFileDiff` lists a file that it does not expand, rather than omits
  it: the file is past a size cap, or the review is past its budget, or the read
  failed outright. A file that leaves the review is a file that the reviewer
  approved without a look at it. The ceilings are per review, not per file,
  because every inlined byte exists three times: the read buffer, the line
  objects of `parseUnifiedDiff`, and the JSON that goes to the browser. A wide
  untracked tree without an aggregate ceiling fills the memory, or it makes a
  hook that outlives its timeout. `filterFiles` runs *after* this, thus `-I` and
  `-X` cannot reduce this work. Do not move the expansion behind the filters to
  make it cheaper: the budget is what bounds it.
- Use ESM with `.js` import specifiers. Use the `node:` prefix for the
  builtins. Use `execFile` for git, never a shell. Keep the runtime dependencies
  at zero.
- `.github/skills/` is the only skill tree, and `install.ps1` copies it without
  a change into `%USERPROFILE%\.copilot\skills\`. `test/skills.test.ts` sends
  each command line that a SKILL.md quotes through `parseArgs`, thus the
  documents and the CLI cannot drift apart in silence. `test/docs.test.ts` does
  the same for `README.md` and for this file: each `--help` flag must be in the
  README, each documented `revgate …` command must parse, and this file must
  list each `src/` module. Thus an edit to a document alone can fail `npm test`.
- **The installed hook files are not source.** `install.ps1` writes the
  generated hook only to `%USERPROFILE%\.copilot\hooks\`, with an absolute path
  to *this* clone. `.github/hooks/revgate.json` is no longer installer output,
  but it stays in `.gitignore`. A hand-made copy in the repository gives each
  other clone a `preToolUse` hook that cannot run, and that hook fails closed.
- **The tests use a real git repository, never the user's.** Each test that
  touches git builds a throwaway repository with `createRepo()` from
  `test/helpers/repo.ts`. That helper pins `user.name` and `user.email`, turns
  off signing and `core.autocrlf`, and starts on `main`. No test in the suite
  can run git, npm or the installer against this checkout. node:test runs the
  test files concurrently, thus an `npm install` or an `npm run build` in the
  middle of the suite rewrites `node_modules/` and `dist/` under the 200 tests
  that spawn children out of them. For this reason `test/install.test.ts` uses
  `install.ps1 -SkipBuild`.
- **You cannot import `src/index.ts`.** It calls `main()` on import, thus
  `test/index.test.ts` spawns it as a real process and asserts on stdout, on
  stderr and on the exit code. That is the only honest way to test the three
  output contracts. Logic that needs a unit test goes into a module that a test
  can import. The report and exit-code choice is in `src/review/report.ts` as
  `reviewReport` for this reason, and each command body is in `src/cli/`.
  `index.ts` keeps only the dispatch.
- **Comments are moderate, and revgate measures them.** Keep a one-line JSDoc on
  each exported symbol. Add a short "why" note only where the code is not
  obvious, or where it guards an invariant. Write no narrative and no history.
  Do not restate the code. The full reasoning is in these Rules, and that is why
  they are long. `test/comments.test.ts` fails the build if a file in `src/` or
  in `test/` goes above 20% comment lines. `src/shared/log.ts` is the one
  exemption: it has two exported one-liners in a file of nine lines, thus its
  two JSDoc lines are already above the ceiling.
- **`package.json` holds two invariants that a refactor breaks in silence.** The
  `test` script must keep its glob quoted, so that `node --test` expands
  `test/**` and not the shell. A shell that expands it matches one directory
  level, and a green run over part of the suite looks exactly like a green run
  over all of it. And `bin.revgate` must stay `dist/index.js`, because
  `install.ps1` and the generated `preToolUse` hook both spell that path out,
  and that hook fails **closed**. `test/package.test.ts` holds both. It also
  asserts that test files exist at two directory depths, because without both
  depths the quoting check proves nothing.
- Each change comes with tests, and `npm test` must be green before you go on.
