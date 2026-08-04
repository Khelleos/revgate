# Refactor install.ps1: global-only install, remove the demo feature

## Overview

Simplify install.ps1 to a single install route: running it always installs the CLI, the skills, and the global plan hook — no interactive prompt, no scope switches. Remove the `--demo` feature entirely: the CLI flag, the bundled sample plan, the `npm run demo` / `demo:plan` scripts, and every mention in code comments, tests, and docs.

Per the accepted scope decision: drop `-Repo` and `-Skills` entirely; keep `-Uninstall`, `-SkipBuild`, `-Timeout`, and `-Help`.

## Context

- Files involved:
  - `install.ps1` — interactive prompt, `-Global`/`-Repo`/`-Skills` switches, demo lines in the success message
  - `test/install.test.ts` — behavioural tests for `-Repo`/`-Skills` routes, source-text assertions
  - `src/cli.ts` — `demo` option, `--demo` parsing, help text
  - `src/index.ts` — `SAMPLE_PLAN`, demo fallback in `resolvePlan`, `!options.demo` in the empty-diff branch
  - `src/output.ts`, `public/index.html` — comments referencing `--demo`
  - `package.json` — `demo` and `demo:plan` scripts
  - `test/cli.test.ts`, `test/index.test.ts`, `test/output.test.ts`, `test/copilot.test.ts`, `test/docs.test.ts` — demo tests and fixtures
  - `README.md`, `agents.md`, `.github/skills/revgate-review/SKILL.md` — install docs and demo mentions
- Related patterns: install tests sandbox `USERPROFILE` and always pass `-SkipBuild` (the global npm install must never fire from a test); `preToolUse` fails closed, so the hook-write path keeps its existence guard and fail-open JSON untouched
- Dependencies: none new

## Development Approach

- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- Behaviour to preserve: hook JSON shape (version, preToolUse, existence guard, fail-open decision, numeric timeoutSec), `-SkipBuild` bailing out before `npm install -g`, uninstall working from a deleted checkout, second uninstall being a no-op
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Refactor install.ps1 to a single global route

**Files:**
- Modify: `install.ps1`
- Modify: `test/install.test.ts`

- [x] Remove `$Global`, `$Repo`, `$Skills` params; keep `$Timeout`, `$Uninstall`, `$SkipBuild`, `$Help`
- [x] Remove `$SkillsOnly`, `Assert-Repo`, and the `scope` parameter of `Get-HookTarget` (or inline the global target path); remove the interactive prompt from `Invoke-Install`
- [x] `Invoke-Install` becomes unconditional: Assert-Node, Invoke-Build, Install-Bin, write the global hook to `%USERPROFILE%\.copilot\hooks\revgate.json`, Install-Skills — no branches
- [x] `Invoke-Uninstall` becomes unconditional: remove the global hook and the skills; keep the no-op-on-second-run behaviour and the `npm uninstall -g revgate` hint
- [x] Rewrite the header comment and `Show-Usage` for the new switch set; drop the two `--demo` "Try it now" lines from the success message
- [x] Update `test/install.test.ts`: delete the `-Repo` and `-Skills` behavioural tests; rewrite the remaining ones so a plain `.\install.ps1 -SkipBuild -Timeout 42` (sandboxed `USERPROFILE`) writes the global hook with the documented JSON shape (guards, fail-open, numeric timeout) AND installs both skills byte-identically; `-Uninstall` removes hook and skills, twice is a no-op; keep the source-text tests for `npm install -g .` guarded by `-SkipBuild`, dropping the `-Skills` source-text test; keep the `-Uninstall`-with-source-tree-gone test (drop its `-Skills` arg); keep the hooks/revgate.json template tests unchanged; update the "no committed hook file" test's comment (the installer no longer writes `.github/hooks`, but a hand-copied template still could)
- [x] run project test suite (`npm test`) - must pass before task 2

### Task 2: Remove --demo from the CLI

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/index.ts`
- Modify: `test/cli.test.ts`
- Modify: `test/index.test.ts`

- [x] `src/cli.ts`: remove the `demo` field from `CliOptions` and `defaultOptions()`, the `--demo` case in the parser, and the `--demo` lines from the help text
- [x] `src/index.ts`: remove `SAMPLE_PLAN`; in `resolvePlan`, remove the demo fallback and drop ", or use --demo" from the error message; in `reviewDiff`, change `files.length === 0 && !options.demo` to `files.length === 0` and fix the comment
- [x] `test/cli.test.ts`: remove the `--demo` parse tests and every `--demo` entry in flag matrices
- [x] `test/index.test.ts`: remove the `--demo --plan` sample-plan test, the `--demo` outside-a-repo test, and `--demo` entries in test matrices
- [x] Add/adjust a test asserting `--plan` with no file and no `$REVGATE_PLAN_FILE` exits 2 with the new message (no `--demo` hint)
- [x] run project test suite - must pass before task 3

### Task 3: Purge remaining demo references from code and scripts

**Files:**
- Modify: `src/output.ts`
- Modify: `public/index.html`
- Modify: `package.json`
- Modify: `test/output.test.ts`
- Modify: `test/copilot.test.ts`

- [x] `package.json`: remove the `demo` and `demo:plan` scripts
- [x] `src/output.ts`: keep `reviewReport`'s "only when no verdict exists" guards (a plan review can still produce a verdict outside a repo / with an empty file list) but reword the two comments that justify them via `--demo`
- [x] `test/output.test.ts`: keep the verdict-preservation tests; reword their `--demo` comments to the plan-review rationale
- [x] `public/index.html`: reword the comment referencing `--demo` on a clean tree
- [x] `test/copilot.test.ts`: replace the `"demo"` string in the invalid-session-id fixture list with a neutral value
- [x] run project test suite - must pass before task 4

### Task 4: Update documentation and doc tests

**Files:**
- Modify: `README.md`
- Modify: `agents.md`
- Modify: `.github/skills/revgate-review/SKILL.md`
- Modify: `test/docs.test.ts`

- [x] `README.md`: rewrite the Install section — plain `.\install.ps1` installs globally, no "asks where" paragraph, no `-Global`/`-Repo`/`-Skills` examples (keep `-Timeout`, `-Help`); fix the install row of the comparison table; rewrite the Uninstall section to the single `-Uninstall` form; update the Upgrade snippet; remove the `--demo` command examples, the `--demo` flag-table row, and the `npm run demo`/`demo:plan` dev commands; update the `.github/hooks` "never committed" paragraph (no longer installer output)
- [x] `agents.md`: remove `npm run demo`/`demo:plan` from the commands list and the `--demo --no-open` tip; update the `install.ps1 -Repo .` reference in the installed-hook-files note
- [x] `.github/skills/revgate-review/SKILL.md`: remove `--demo` from the pass-through flag list
- [x] `test/docs.test.ts`: in "documents the installer routes", replace the `-Global`/`-Skills` assertions with a plain `install.ps1` assertion plus `doesNotMatch` for the removed switches; remove `npm run demo` from the required-commands list
- [x] run project test suite - must pass before task 5

### Task 5: Verify acceptance criteria

- [x] run full test suite (`npm test`) — 306 tests, 302 pass, 4 skipped, 0 fail
- [x] run `npm run build` (tsc is the project's type check; no separate linter is configured) — clean
- [x] grep the repo for `demo` (case-insensitive) — only hit is the intentional `doesNotMatch(/--demo/)` regression test from Task 2
- [x] grep `install.ps1` and docs for `-Repo`, `-Skills`, `-Global` — no switch hits (only benign substrings: `no-repo` prose, `Install-Skills`/`Uninstall-Skills` helper names)

## Post-Completion

- Re-run `.\install.ps1` on a real machine to refresh the installed hook and skills (manual, outside the test sandbox)
