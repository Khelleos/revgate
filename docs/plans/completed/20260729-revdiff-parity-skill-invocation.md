# Skill-driven review: adopt revdiff's on-demand invocation model in revgate

## Overview

revgate today is **hook-only**: it fires from Copilot's `agentStop` (diff gate) and `preToolUse` (plan gate), always reviews the working tree vs `HEAD`, and speaks exactly one output contract (hook decision JSON on stdout). There is no way for the agent — or a human — to *ask* for a review, and no way to scope one.

[umputun/revdiff](https://github.com/umputun/revdiff) takes the opposite stance: it is a standalone reviewer with a rich CLI (refs, `--staged`, `--include`/`--exclude`, `-o`, exit code 10, history dir, config file) that agents drive **through skills and slash commands** across Claude Code, Codex, opencode and Pi. Hooks are used only for the plan gate.

This plan brings revdiff's invocation model to revgate, scoped to **Copilot CLI only**. revgate keeps its browser UI and its hook gates; it gains a real CLI surface, an agent-readable markdown output contract, exit-code signaling, review history, and a Copilot skill + plugin so `/revgate-review` works on demand.

### Gap analysis: revdiff vs revgate

| revdiff capability | revgate today | In this plan |
| --- | --- | --- |
| Skill / slash-command invocation (`/revdiff`) | none — hook-only | Task 6, 7 |
| Ref scoping (`HEAD~3`, `main..feature`, two refs) | working tree vs HEAD only | Task 2, 3 |
| `--staged` | no | Task 2, 3 |
| `--include` / `--exclude` path filters | no | Task 2, 3 |
| Markdown annotation output (`## path:LINE (+)`) | hook JSON only | Task 4 |
| `-o` / `--output` to file | no | Task 4 |
| Exit code 10 when comments captured | no | Task 4 |
| Review history (`history/<repo>/<ts>.md`) | reviews are lost | Task 5 |
| Plugin + marketplace manifest | README claims them; files do not exist | Task 7 |
| TUI, themes, blame, vim motions, hg/jj, `--stdin`, `--only`, config file | n/a | **deferred, out of scope** (revgate is a browser UI, not a TUI; a config file is YAGNI while flags + env cover it) |

### Why a skill beats a hook here

The `agentStop` hook fires on *every* turn end, so it either gates everything or nothing, and the review window is bounded by `timeoutSec`. A skill lets the agent (or the human) say "review what you just did, scoped to `src/`" at a chosen moment, read structured markdown back, and act on it — exactly revdiff's annotation feedback loop. The existing hooks stay as-is for people who want the automatic gate; the skill is additive.

## Context

- Files involved:
  - `src/index.ts` — entry point; currently hand-rolls argv parsing and owns both hook contracts
  - `src/git.ts` — `collectWorkingTreeDiff`, `getStageStates`, `setStaged`
  - `src/diff.ts` — unified-diff parser (unchanged, but gains tests)
  - `src/feedback.ts` — renders the block-prompt markdown from a review
  - `src/plan.ts`, `src/copilot.ts`, `src/server.ts`, `src/types.ts`, `src/log.ts`
  - `hooks/revgate.json`, `install.ps1`, `README.md`, `agents.md`
  - `package.json` — no `test` script exists yet; no test framework at all
- Related patterns to follow:
  - **stdout is a contract.** `src/log.ts` already routes all logging to stderr because Copilot parses stdout. New output modes must preserve that discipline.
  - **Fail open.** Every error path in `index.ts` emits an explicit `allow` and exits 0 — a non-zero exit fails `preToolUse` *closed*. The new CLI paths are *not* hooks, so they may use real exit codes; keep the two worlds clearly separated.
  - Plans are modelled as a synthetic single-file diff (`plan.ts`) so the whole review pipeline works unchanged. Reuse that trick rather than special-casing.
  - ESM + `.js` import specifiers, `node:` prefixed builtins, `execFile` (never shell) for git.
- Dependencies: none new at runtime. Tests use Node's built-in `node:test` + `node:assert` run through the existing `tsx` devDependency — no new test framework.

## Development Approach

- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- Keep runtime dependency count at zero; `node:test` via `tsx` only
- Never widen what goes to stdout without an explicit mode flag
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Test harness and tests for the existing pure modules

There is no test infrastructure at all today. Establish it first so every later task has somewhere to land.

**Files:**
- Modify: `package.json`
- Create: `test/diff.test.ts`
- Create: `test/feedback.test.ts`
- Create: `test/plan.test.ts`
- Create: `test/helpers/repo.ts` (temp-git-repo fixture builder for later tasks)

- [x] add `"test": "tsx --test test/**/*.test.ts"` to `package.json` scripts
- [x] write `test/helpers/repo.ts`: create a temp dir, `git init`, commit files, return cwd + cleanup (used from Task 3 onward)
- [x] test `parseUnifiedDiff` in `src/diff.ts`: added / deleted / renamed / binary files, multi-hunk, `\ No newline at end of file`, addition and deletion counts
- [x] test `buildDecision` in `src/feedback.ts`: approve → `allow`; request_changes → `block` with rendered prompt; single-line vs range comments; plan mode vs diff mode headings; empty-review fallback text
- [x] test `planToFiles` / `planTitle` in `src/plan.ts`: line numbering from 1, CRLF normalization, H1/H2 title extraction, generic fallback
- [x] run `npm test` — must pass before Task 2

### Task 2: A real CLI surface — `revgate review` with revdiff-style scope flags

Replace the ad-hoc `argv.includes(...)` scanning in `index.ts` with a parser module, and introduce the `review` subcommand that the skill will call.

**Files:**
- Create: `src/cli.ts`
- Modify: `src/index.ts`
- Create: `test/cli.test.ts`

- [x] write `src/cli.ts` exporting `parseArgs(argv)` → a discriminated union of `{ command: "review" | "plan" | "copilot-plan" | "agent-stop" }` plus options
- [x] support positional refs mirroring revdiff: none (working tree vs HEAD), one ref (`HEAD~3` — ref vs working tree), two refs (`main feature`), and dotted forms `main..feature` / `main...feature`
- [x] support `--staged`, `--include <prefix>` (repeatable, `-I`), `--exclude <prefix>` (repeatable, `-X`), `--no-open` (skip auto-opening the browser)
- [x] keep `--demo` and `--plan [file]` working through the same parser; route `copilot-plan` to the existing hook path unchanged
- [x] add `--help` text listing every flag, and make an unknown flag an error (exit 2) on the `review` path only — hook paths must still never exit non-zero
- [x] test `parseArgs`: each ref form, repeated `--include`, `--exclude`, `--staged`, `--plan=<path>` vs `--plan <path>` vs bare `--plan`, unknown-flag error, and that `copilot-plan` parses before any flag validation
- [x] run `npm test` — must pass before Task 3

### Task 3: Scope the git diff — refs, staged, and path filters

Teach `git.ts` to produce a diff for the scope Task 2 parsed, and surface that scope in the UI.

**Files:**
- Modify: `src/git.ts`
- Modify: `src/server.ts` (add `scope` to `ReviewContext`)
- Modify: `public/index.html` (render the scope label in the header)
- Modify: `src/index.ts`
- Create: `test/git.test.ts`

- [x] generalize `collectWorkingTreeDiff` into `collectDiff(cwd, scope)` where scope is `{ kind: "worktree" | "staged" | "ref" | "range", refs, include, exclude }`, returning the existing `RepoDiff` plus a human-readable `scopeLabel` (e.g. `main..feature`, `staged changes`)
- [x] build the right git invocation per kind: `diff HEAD` (worktree), `diff --cached` (staged), `diff <ref>` (ref), `diff <a> <b>` / `diff <a>...<b>` (range) — always `--no-color`, always via `execFile` with refs passed after `--` separation where applicable
- [x] validate refs with `git rev-parse --verify` and fail with a clear stderr message + exit 2 rather than passing unvalidated input to git
- [x] apply `include`/`exclude` prefix filters to the parsed `DiffFile[]` (include narrows first, then exclude removes — matching revdiff's documented composition)
- [x] only synthesize untracked-file diffs for the `worktree` scope; ref/range/staged scopes must not pick up untracked files
- [x] add `scope?: string` to `ReviewContext` and show it next to the branch in the UI header
- [x] test with the temp-repo fixture: worktree scope, staged scope, single ref, two refs, dotted range, include-only, exclude-only, include+exclude composition, invalid ref → error, untracked excluded from ref scope
- [x] run `npm test` — must pass before Task 4

### Task 4: Agent-readable output — markdown annotations, `--output`, exit code 10

This is what makes a skill viable: the agent needs to read the review as text, not as hook JSON, and needs a cheap signal for "were there comments?".

**Files:**
- Create: `src/output.ts`
- Modify: `src/feedback.ts` (extract shared comment-grouping helper)
- Modify: `src/index.ts`
- Modify: `src/cli.ts`
- Create: `test/output.test.ts`

- [x] write `src/output.ts` exporting `renderAnnotations(review, files)` producing revdiff's documented record format: `## path` for file-level, `## path:LINE (+)` / `## path:LINE (-)` for single lines, `## path:START-END (+)` for ranges, comment body beneath each header
- [x] prefix continuation lines of multi-line comment bodies with a space so they can never be mistaken for a `##` header (revdiff does this)
- [x] emit the overall verdict and summary as a leading section so the agent sees approve vs request-changes without parsing headers
- [x] add `--output <file>` / `-o` to write the annotations to a file instead of stdout, and `--exit-code-on-comments` to exit `10` when at least one comment or a request-changes verdict was captured (`0` otherwise, `1`/`2` reserved for real errors)
- [x] on the `review` path write annotations to stdout by default (never hook JSON); the `agentStop` and `copilot-plan` paths keep their existing JSON contracts untouched
- [x] refactor the file-grouping loop out of `renderPrompt` in `feedback.ts` so both renderers share it, leaving `buildDecision`'s output byte-identical
- [x] test `renderAnnotations`: file-level, single-line new side, single-line old side, range, multiple files, multi-line body indentation, empty review; test exit-code selection logic; test that `buildDecision` output is unchanged (the Task 1 snapshot in `test/feedback.test.ts` still passes verbatim)
- [x] run `npm test` — must pass before Task 5

### Task 5: Review history persistence

revdiff auto-saves every annotated review; revgate currently drops the review on the floor if the hook times out or the agent ignores it. This makes reviews recoverable and gives the skill a fallback read path.

**Files:**
- Create: `src/history.ts`
- Modify: `src/index.ts`
- Modify: `src/cli.ts`
- Create: `test/history.test.ts`

- [x] write `src/history.ts` exporting `saveHistory(review, files, meta)` writing markdown to `<historyDir>/<repo-name>/<timestamp>.md`, where `historyDir` is `--history-dir`, else `$REVGATE_HISTORY_DIR`, else `~/.revgate/history`
- [x] derive `<repo-name>` from the git toplevel basename, sanitized to a safe path segment; fall back to `no-repo` outside a repository
- [x] write history on every submitted review that has comments or a request-changes verdict, on all paths (skill, `agentStop`, `copilot-plan`) — reuse `renderAnnotations` from Task 4 for the body, with a header recording scope, branch, session id and timestamp
- [x] make history failures non-fatal: warn to stderr and continue, so a read-only home directory can never wedge a gate
- [x] add `--no-history` to opt out
- [x] test: file written to the expected path, name sanitization, `--no-history` writes nothing, approve-with-no-comments writes nothing, unwritable directory warns instead of throwing
- [x] run `npm test` — must pass before Task 6

### Task 6: Copilot skills — invoke revgate on demand instead of only via hooks

The headline change. Two skills so the agent can request either kind of review, discoverable both automatically (description match) and explicitly (`/revgate-review`).

**Files:**
- Create: `.github/skills/revgate-review/SKILL.md`
- Create: `.github/skills/revgate-plan/SKILL.md`
- Create: `test/skills.test.ts`

- [x] write `.github/skills/revgate-review/SKILL.md` with frontmatter `name: revgate-review`, a `description` that names the trigger phrases ("review my changes", "open a review", "gate this diff"), and `argument-hint` describing the optional ref/scope argument
- [x] document the agent loop in the skill body: run `revgate review [<refs>] [--staged] [--include ...] [--exclude ...] --exit-code-on-comments`; exit `10` means comments were captured on stdout; exit `0` means approved with nothing to do; any other code is an error to report, not to retry
- [x] instruct the agent how to consume the annotation format — treat each `## path:LINE` record as a directive against that exact location, address every one, then summarize what changed
- [x] write `.github/skills/revgate-plan/SKILL.md` calling `revgate review --plan <file>` for reviewing a plan document on demand, covering the case where the user is not in Copilot plan mode so `preToolUse` never fires
- [x] test `test/skills.test.ts`: every `SKILL.md` parses as YAML frontmatter + body, has non-empty `name`/`description`, the `name` matches its directory name, and every `revgate` command line quoted in the body parses cleanly through `parseArgs` from Task 2 (this is the check that keeps docs and CLI from drifting)
- [x] run `npm test` — must pass before Task 7

### Task 7: Copilot plugin packaging and installer support

The README already promises `.github/plugin/marketplace.json` and `copilot-plugin/`, and `package.json` already ships `copilot-plugin` in `files` — but neither exists. Make the documented install path real, and bundle the skills with it.

**Files:**
- Create: `copilot-plugin/plugin.json`
- Create: `copilot-plugin/hooks.json`
- Create: `copilot-plugin/skills/revgate-review/SKILL.md`
- Create: `copilot-plugin/skills/revgate-plan/SKILL.md`
- Create: `.github/plugin/marketplace.json`
- Modify: `install.ps1`
- Create: `test/plugin.test.ts`

- [x] write `copilot-plugin/plugin.json` (name, version, description, author, license) matching `package.json`'s version
- [x] write `copilot-plugin/hooks.json` with the existing `preToolUse` → `revgate copilot-plan` and `agentStop` → `revgate` entries, invoking the `revgate` bin from PATH (the plugin path assumes a global install; `install.ps1` keeps pinning absolute paths)
- [x] make `copilot-plugin/skills/*` the packaged copies of the Task 6 skills — generate them from `.github/skills/` in a small `npm run sync:skills` script so there is exactly one source of truth
- [x] write `.github/plugin/marketplace.json` declaring the marketplace and listing the `revgate-copilot` plugin with its source path
- [x] add `install.ps1 -Skills` to copy the skills into `%USERPROFILE%\.copilot\skills\` (and `-Uninstall -Skills` to remove them), so a non-plugin user gets `/revgate-review` too; keep the default install behaviour unchanged
- [x] test `test/plugin.test.ts`: `plugin.json`, `hooks.json` and `marketplace.json` are valid JSON with the required keys; the plugin version equals `package.json`'s; the packaged skills are byte-identical to `.github/skills/` (the drift guard for `sync:skills`)
- [x] run `npm test` — must pass before Task 8

### Task 8: Verify acceptance criteria

- [x] run `npm test` — full suite must pass (181 tests at the time of this task; the suite has grown since with the post-Task-9 hardening)
- [x] run `npm run build` — TypeScript must compile clean with no new errors
- [x] verify `node dist/index.js review --help` prints every flag and exits 0
- [x] verify `node dist/index.js review --demo --no-open` starts and serves, and `node dist/index.js --demo --plan --no-open` still works (no regression in the existing demo paths) — both serve on 127.0.0.1; `/` and `/api/review` return 200, and the plan path reports `mode: plan` with the sample plan's title
- [x] verify coverage of `src/` is 80%+ via `tsx --test --experimental-test-coverage` — every `src/` module is 93.7%–100% line coverage; only `types.ts` is absent from the report because it is type-only and emits no runtime code

Closing the coverage gap needed tests for the three modules that had none — `copilot.ts`, `server.ts` and `index.ts`:

- [x] add `test/copilot.test.ts`: session-keyed plan lookup, UUID validation rejecting traversal-shaped ids, newest-plan fallback
- [x] add `test/server.test.ts`: static serving, traversal rejection, `/api/review`, `/api/submit` (valid and malformed), `/api/stage` and `/api/unstage` against a real repo, and `close()` rejecting a pending review
- [x] add `test/index.test.ts`: the entry point driven as a real process (it runs `main()` on import), covering `--help`, exit 2 on an unknown flag and an unresolvable ref, the clean-tree and non-repo paths, `-o`, a full submit round trip asserting exit 10, plan mode, and both hook output contracts

### Task 9: Update documentation

- [x] rewrite `README.md`: a "Two ways to run revgate" section (hook gate vs skill), the full `revgate review` flag reference with revdiff-style examples (`revgate review main..feature --include src`), the annotation output format, exit codes (0 / 10 / 1 / 2), history location and `--history-dir`, and corrected plugin install instructions now that the manifests exist
- [x] update `agents.md` with the new modules (`cli.ts`, `output.ts`, `history.ts`), the `npm test` and `npm run sync:skills` commands, and the stdout-contract rule
- [x] add a short "Design notes: what we took from revdiff" section to `README.md` crediting umputun/revdiff and listing what was deliberately deferred (TUI, themes, blame, hg/jj, `--stdin`, config file)
- [x] add `test/docs.test.ts` as the docs/CLI drift guard: every `revgate` command quoted in `README.md` parses through `parseArgs`, every flag in `--help` is documented, and the annotation/exit-code/history/plugin/revdiff sections are present (190 tests at the time of this task; the suite has grown since)

## Post-Completion

Manual checks that cannot be automated:

- In Copilot CLI, run `/skills reload` then `/revgate-review src` and confirm the browser review opens, comments come back on stdout, and Copilot acts on them
- Confirm `/plugin marketplace add <owner>/revgate` then `/plugin install revgate-copilot@revgate` installs cleanly
- Confirm the `agentStop` and plan gates still fire correctly after a fresh `.\install.ps1`
