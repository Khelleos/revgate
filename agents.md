# revgate: Agents Guide

Human-in-the-loop review for GitHub Copilot CLI. revgate opens a local web UI
where a person reviews a diff (or a plan) like a GitHub PR, and hands their
comments back to the agent.

It is manual-first with one automatic exception, and the difference matters
when you change code:

- **Command / skill (the default)** — `revgate review`, driven by the
  `/revgate-review` and `/revgate-plan` skills. Output is markdown annotations
  on stdout; real exit codes apply (`0`, `10` with `--exit-code-on-comments`,
  `1`, `2`).
- **Plan hook (the exception)** — `preToolUse` → `revgate copilot-plan`. Output
  is Copilot's permission-decision JSON on stdout; this path must **always exit
  0**. It is the only hook: the `agentStop` diff gate was removed in 0.2.0, and
  bare `revgate` is now a usage error (exit 2), not a hook entry.

## Modules

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Entry point; routes `review` vs the `copilot-plan` hook, owns both output contracts |
| `src/cli.ts` | `parseArgs(argv)` → discriminated union of commands + options; `helpText()` |
| `src/git.ts` | `collectDiff(cwd, scope)`, `describeScope`, `filterFiles`, `getStageStates`, `setStaged`, `ScopeError` |
| `src/diff.ts` | Unified-diff parser |
| `src/plan.ts` | `planToFiles` / `planTitle` — a plan is modelled as a synthetic single-file diff so the whole review pipeline works unchanged |
| `src/copilot.ts` | Locates Copilot's per-session `plan.md` |
| `src/server.ts` | The local review server + `ReviewContext`; serves `public/` and the review APIs |
| `src/feedback.ts` | `buildDecision` — renders the hook JSON and the block prompt; `groupCommentsByFile` |
| `src/output.ts` | `renderAnnotations`, `renderNoReview`, `reviewReport`, `reviewExitCode`, `hasFindings` — the agent-readable contract |
| `src/history.ts` | `saveHistory` — archives reviews under `<historyDir>/<repo>/<timestamp>.md` |
| `src/log.ts` | `log` / `warn` — **stderr only** |
| `src/types.ts` | Shared types |

## Commands

```bash
npm install            # installs AND builds (prepare → tsc); a type error fails the install
npm run build          # tsc → dist/
npm test               # node:test via tsx — needs Node >= 21 (node --test expands the glob); revgate itself runs on 18
npm run demo           # UI against your working tree, no build
npm run demo:plan      # plan UI with the bundled sample plan
npm run sync:skills    # regenerate copilot-plugin/skills/ from .github/skills/
```

Quick manual check: `node dist/index.js review --help`, then
`node dist/index.js review --demo --no-open`.

## Rules

- **stdout is a contract.** All logging goes to stderr because Copilot parses
  stdout. Never widen what reaches stdout without an explicit mode flag:
  `copilot-plan` emits exactly one `PermissionDecision`, `review` only
  annotations (or nothing, with `--output`).
- **The hook must fail open.** Every error path on `copilot-plan` emits an
  explicit `allow` and exits 0 — a non-zero exit fails `preToolUse` *closed*.
  Only `revgate review` may exit non-zero, and every non-hook invocation is a
  `review` invocation (a bad one exits 2; it must never fall through to a hook
  shape on stdout).
- **History is best-effort.** `saveHistory` never throws; it warns and continues.
- **The review server is a trust boundary.** It binds `127.0.0.1` on a random
  port, and rejects — before routing, so a new route inherits both guards — any
  request whose `Host` is not loopback-on-our-port (DNS rebinding would
  otherwise read the whole diff) and any cross-origin POST. Every submission is
  coerced in `normalizeSubmission`/`normalizeComment` at that same entry point:
  downstream renderers read `body`/`file`/`startLine` unchecked, and a throw
  inside the fail-open handler would report a forged *approval*. Three more
  invariants a new route inherits and must not opt out of: every response carries
  `content-security-policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`,
  because a framed UI turns a stray click into a same-origin (and therefore
  guard-passing) approval; request bodies go through `readBody`, capped at
  `MAX_BODY_BYTES` → 413, since this process is blocking a hook and an unbounded
  body stalls the turn; and every index mutation — plus the `getStageStates` read
  beside it — runs inside `serializeIndexWork`, because `.git/index.lock` makes
  concurrent `git add`/`reset` fail outright.
- **Three files carry the version.** `package.json`,
  `copilot-plugin/plugin.json` and the `revgate-copilot` entry in
  `.github/plugin/marketplace.json` must all match — `test/plugin.test.ts` fails
  otherwise. Bump them in one commit.
- **All git goes through `git()` / `gitDiff()`.** Never call
  `execFileAsync("git", …)` anywhere else: `git()` injects `HARDENED_CONFIG`
  (`core.quotePath`, `diff.relative`, `diff.noprefix`, `diff.mnemonicPrefix`,
  `diff.srcPrefix`/`dstPrefix`, `status.showUntrackedFiles`) and each of those,
  left inherited from the reviewer's own `~/.gitconfig`, either renames or
  silently drops files from the review. `gitDiff()` adds `--no-ext-diff` on top,
  because `diff.external` is the one setting `-c` cannot switch off — an external
  driver makes git exit 0 with output the parser reads as an empty diff, so the
  gate reports APPROVED over changes nobody saw. `src/diff.ts` still unquotes
  what git quotes anyway (a `"` or a control character in a name). Paths must
  reach `filterFiles` and the annotation renderer exactly as they exist on disk.
- **Untracked content is bounded, never dropped.** `untrackedFileDiff` lists a
  file it will not expand rather than omitting it — past a size cap, past the
  per-review budget, or when the read fails outright. A file that leaves the
  review is a file the reviewer approved without seeing.
- ESM with `.js` import specifiers, `node:`-prefixed builtins, `execFile` (never
  a shell) for git. Zero runtime dependencies — keep it that way.
- `.github/skills/` is the source of truth for skills; `copilot-plugin/skills/`
  is generated. `test/skills.test.ts` parses every command line quoted in a
  SKILL.md through `parseArgs`, and `test/plugin.test.ts` guards against drift —
  so docs and CLI cannot diverge silently. `test/docs.test.ts` does the same for
  `README.md` and this file: every `--help` flag must appear in the README, every
  documented `revgate …` command must parse, and this file must list every `src/`
  module. A doc-only edit can therefore fail `npm test`.
- **Installed hook files are not source.** `install.ps1 -Repo .` writes
  `.github/hooks/revgate.json` with an absolute path to *this* clone; it is
  gitignored. Committing one hands every other clone a `preToolUse` hook that
  cannot run — and that fails closed.
- **Tests use real git, never the user's.** Anything touching git builds a
  throwaway repo with `createRepo()` from `test/helpers/repo.ts` — it pins
  `user.name`/`user.email`, disables signing and `core.autocrlf`, and starts on
  `main`. Nothing in the suite may run git, npm or the installer against this
  checkout: node:test runs test files concurrently, so a `npm install`/`npm run
  build` mid-suite rewrites `node_modules/` and `dist/` under the ~200 tests that
  spawn children out of them (hence `install.ps1 -SkipBuild` in
  `test/plugin.test.ts`).
- **`src/index.ts` cannot be imported.** It runs `main()` on import, so
  `test/index.test.ts` spawns it as a real process and asserts on stdout, stderr
  and the exit code — the only honest way to test the three output contracts.
  Logic that needs unit tests goes in a module it can import: the
  report/exit-code choice lives in `output.ts` as `reviewReport` for that reason.
- Every change ships with tests, and `npm test` must be green before moving on.
