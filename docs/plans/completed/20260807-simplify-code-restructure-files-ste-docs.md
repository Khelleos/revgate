# Simplify the code, restructure the files, and rewrite the text in Simplified Technical English

## Overview

This plan does three things:

1. It groups `src/` into packages by concern, and it adds an `src/integrations/` package. The future JIRA integration goes into that package next to `copilot.ts`.
2. It divides the five largest modules into focused files, and it divides `public/index.html` into markup, CSS, and script.
3. It removes unnecessary comments with the agreed moderate policy, and it rewrites `README.md`, `agents.md`, and the SKILL.md files in ASD-STE100 Simplified Technical English.

The plan does not change behavior. All output contracts, exit codes, and security guards stay the same.

## Recommended structure

The user asked for a recommendation, and said that JIRA integration comes later. This plan uses the full grouped layout with a separate integrations package. Reasons:

- `copilot.ts` is the only integration today. It is 57 lines, and it hides in a flat list of 13 files. A JIRA client is larger. If you add it to a flat `src/`, the flat list becomes 20+ files with no order.
- The name is `integrations/`, not `tools/`. The word "tool" already has a different meaning in this project (Copilot tool calls, `toolName` in `HookPayload`). The name `integrations/` says "code that speaks to an external product": Copilot CLI today, JIRA later.
- The plan does not add an abstract integration interface now. Copilot reads a plan file. JIRA speaks HTTP. One example is not enough to find the correct shared shape. The package gives JIRA a home; the shape can come later.
- The plan includes the `public/` asset split. The server already has a MIME map, so it serves `.css` and `.js` today with no change. A 1,046-line HTML file is the largest single file in the project.

Proposed layout:

```
src/
  index.ts                 entry point; dispatch only (bin target dist/index.js does not move)
  cli/
    args.ts                parseArgs, CliOptions, ParsedArgs
    help.ts                HELP text, helpText()
    review-command.ts      runReviewCommand, reviewDiff, resolvePlan
    plan-hook.ts           runCopilotPlanHook, gatePlan, readHookPayload, emitPermission
  git/
    exec.ts                git(), gitDiff(), HARDENED_CONFIG, repo detection
    scope.ts               DiffScope, ScopeError, describeScope, path filters
    untracked.ts           untracked budget and untrackedFileDiff
    collect.ts             collectDiff, RepoDiff
    staging.ts             getStageStates, setStaged
  review/
    diff.ts                parseUnifiedDiff, unquoteGitPath
    plan.ts                planToFiles, planTitle
    feedback.ts            buildDecision, groupCommentsByFile
    annotations.ts         renderAnnotations and the other renderers
    report.ts              reviewReport, reviewExitCode, hasFindings
  server/
    index.ts               startReviewServer, routes, ReviewContext
    http.ts                readBody, json, MIME, isLoopbackAuthority, headers
    normalize.ts           normalizeComment, normalizeSubmission
    browser.ts             openBrowser
  integrations/
    copilot.ts             findCopilotPlanContent  (jira.ts goes here later)
  store/
    palettes.ts            Theme, PALETTE_KEYS, BUILTIN_THEMES
    theme-config.ts        configDir, readThemeConfig, writeThemeConfig, listThemes
    history.ts             saveHistory and the document renderer
  shared/
    types.ts
    log.ts
public/
  index.html               markup only
  app.css                  all styles, and both :root blocks
  app.js                   the UI script
  fonts/
test/                      mirrors src/; index.test.ts, docs.test.ts,
                           skills.test.ts, install.test.ts stay at the root
```

## Context

- Files involved: all 13 modules in `src/`, all 14 test files in `test/`, `public/index.html`, `agents.md`, `README.md`, `.github/skills/*/SKILL.md`, `tsconfig.json`, `package.json`.
- Related patterns: ESM with `.js` import specifiers, `node:` builtins, zero runtime dependencies, `node:test` through `tsx`.
- Dependencies: none. No new package is necessary.

## Constraints that the plan must respect

These come from `agents.md` and from the code. Each one is a way this refactor can break silently.

- `src/index.ts` stays at the root of `src/`. `package.json` `bin` points to `dist/index.js`, and `install.ps1` and the installed hook use that path.
- `server.ts` computes `PUBLIC_DIR` as `path.resolve(__dirname, "..", "public")`. After the move, the compiled file is `dist/server/index.js`. The path needs one more `".."`.
- `test/docs.test.ts` holds a hard-coded list of `src/` module names. `agents.md` must list every module.
- `test/theme.test.ts` parses the two `:root` blocks out of `public/index.html`. After the asset split, it must parse `public/app.css`.
- `test/server.test.ts` reads `public/index.html` for the theme picker markup and the built-in ids.
- `npm test` uses the glob `test/**/*.test.ts`. Task 1 confirms that the glob finds tests in the new subdirectories.
- The comment policy is Moderate: keep a short "why" note only where the code is not obvious or where a guard is present. Delete narrative and historical prose. Move the full reasoning to `agents.md`.

## Development Approach

- **Testing approach**: Regular (code first, then tests).
- Complete each task fully before you start the next task.
- Move files with `git mv` to keep the history.
- Each task is a move plus an import fix. No task changes behavior.
- **CRITICAL: every task MUST include new or updated tests**
- **CRITICAL: all tests must pass before you start the next task**

## Implementation Steps

### Task 1: Create the shared and integrations packages

**Files:**
- Move: `src/types.ts` → `src/shared/types.ts`, `src/log.ts` → `src/shared/log.ts`, `src/copilot.ts` → `src/integrations/copilot.ts`
- Move: `test/copilot.test.ts` → `test/integrations/copilot.test.ts`
- Modify: every `src/*.ts` that imports `./types.js` or `./log.js`, `package.json`

- [x] `git mv` the three modules into `src/shared/` and `src/integrations/`
- [x] fix the import specifiers in all callers
- [x] `git mv test/copilot.test.ts test/integrations/copilot.test.ts` and fix its relative imports
- [x] run `npm test`, and confirm that the glob finds the test in the new subdirectory; if it does not, quote the glob in the `test` script
- [x] run `npm run build`, and confirm that `dist/index.js` is still the entry point
- [x] run the project test suite; it must pass before Task 2

### Task 2: Divide the git module into a package

**Files:**
- Create: `src/git/exec.ts`, `src/git/scope.ts`, `src/git/untracked.ts`, `src/git/collect.ts`, `src/git/staging.ts`
- Delete: `src/git.ts`
- Move: `test/git.test.ts` → `test/git/` as `scope.test.ts`, `untracked.test.ts`, `collect.test.ts`, `staging.test.ts`

- [x] move `git()`, `gitDiff()`, `HARDENED_CONFIG`, `gitErrorMessage`, `hasHead`, `isGitRepo`, `findRepoRoot`, and `repoRoot` to `exec.ts`
- [x] move `DiffScope`, `ScopeError`, `describeScope`, `verifyArity`, `verifyRef`, the path helpers, and `filterFiles` to `scope.ts`
- [x] move `looksBinary`, the byte and file budgets, and `untrackedFileDiff` to `untracked.ts`
- [x] move `RepoDiff` and `collectDiff` to `collect.ts`; move `isUnmerged`, `getStageStates`, and `setStaged` to `staging.ts`
- [x] keep `git()` and `gitDiff()` unexported outside `src/git/`, so the rule "all git goes through `git()`" stays enforceable
- [x] fix the imports in `src/index.ts` and `src/server.ts`
- [x] divide `test/git.test.ts` along the same lines, and fix the `helpers/repo.js` paths
- [x] run the project test suite; it must pass before Task 3

### Task 3: Create the review package

**Files:**
- Move: `src/diff.ts`, `src/plan.ts`, `src/feedback.ts` into `src/review/`
- Create: `src/review/annotations.ts`, `src/review/report.ts` (from `src/output.ts`)
- Delete: `src/output.ts`
- Move: the matching test files into `test/review/`

- [x] `git mv` `diff.ts`, `plan.ts`, and `feedback.ts` into `src/review/`
- [x] move the renderers (`renderAnnotations`, `renderNoReview`, `renderNothingInScope`, `renderUntrackedScanFailed`, `renderDroppedPaths`, `AnnotationMeta`, `renderBody`) to `annotations.ts`
- [x] move `reviewReport`, `reviewExitCode`, `hasFindings`, `ReviewReport`, and `ReviewOutcomeSummary` to `report.ts`
- [x] fix the imports in `src/index.ts` and `src/server.ts` (`server.ts` imports none of these; `src/history.ts` and `src/git/collect.ts` did, and were fixed)
- [x] move the tests to `test/review/`, and divide `output.test.ts` into `annotations.test.ts` and `report.test.ts`
- [x] run the project test suite; it must pass before Task 4

### Task 4: Create the server package

**Files:**
- Create: `src/server/index.ts`, `src/server/http.ts`, `src/server/normalize.ts`, `src/server/browser.ts`
- Delete: `src/server.ts`
- Modify: `src/index.ts` (remove `openBrowser`)
- Move: `test/server.test.ts` → `test/server/` as `server.test.ts` and `normalize.test.ts`

- [x] move `startReviewServer`, the routes, `ReviewContext`, and `ServerHandle` to `server/index.ts`
- [x] move `json`, `readBody`, `BodyTooLarge`, `MAX_BODY_BYTES`, `MIME`, `isLoopbackAuthority`, and the frame headers to `http.ts`
- [x] move `normalizeComment` and `normalizeSubmission` to `normalize.ts`
- [x] move `openBrowser` out of `src/index.ts` into `server/browser.ts`
- [x] change `PUBLIC_DIR` to `path.resolve(__dirname, "..", "..", "public")`, because the compiled file is now one level deeper
- [x] add a test that starts the server and gets `GET /` with status 200, to prove that `PUBLIC_DIR` is correct after the build
- [x] divide the tests into `test/server/server.test.ts` and `test/server/normalize.test.ts`
- [x] run the project test suite; it must pass before Task 5

### Task 5: Create the store package

**Files:**
- Create: `src/store/palettes.ts`, `src/store/theme-config.ts`
- Move: `src/history.ts` → `src/store/history.ts`
- Delete: `src/theme.ts`
- Move: `test/theme.test.ts` → `test/store/theme-config.test.ts`, `test/history.test.ts` → `test/store/history.test.ts`

- [x] move `Theme`, `SYSTEM_THEME_ID`, `PALETTE_KEYS`, `BUILTIN_THEMES`, and `isKnownThemeId` to `palettes.ts`
- [x] move `ThemeConfig`, `configDir`, `configFile`, `readThemeConfig`, `writeThemeConfig`, `saveThemeConfig`, `ThemeListing`, and `listThemes` to `theme-config.ts`
- [x] keep the write queue inside `theme-config.ts`; it must stay one module-level queue
- [x] `git mv` `history.ts` into `src/store/`
- [x] fix the imports in `src/server/index.ts` and `src/index.ts`
- [x] move and rename the tests; divide the palette assertions into `test/store/palettes.test.ts`
- [x] run the project test suite; it must pass before Task 6

### Task 6: Create the cli package and make the entry point thin

**Files:**
- Create: `src/cli/args.ts`, `src/cli/help.ts`, `src/cli/review-command.ts`, `src/cli/plan-hook.ts`
- Modify: `src/index.ts` (reduce to dispatch)
- Delete: `src/cli.ts`
- Move: `test/cli.test.ts` → `test/cli/args.test.ts`

- [x] move `parseArgs`, `CliOptions`, `ParsedArgs`, `splitRange`, `defaultOptions`, and `parseOptions` to `cli/args.ts`
- [x] move the `HELP` template and `helpText()` to `cli/help.ts`
- [x] move `runReviewCommand`, `reviewDiff`, and `resolvePlan` to `cli/review-command.ts`
- [x] move `runCopilotPlanHook`, `gatePlan`, `readHookPayload`, `emitPermission`, and `parseToolArgs` to `cli/plan-hook.ts`
- [x] reduce `src/index.ts` to the shebang, `main()`, and the dispatch; it must keep the fail-open behavior of the hook path
- [x] add unit tests for `readHookPayload` and `gatePlan`, which are now importable; keep the process-level tests in `test/index.test.ts`
- [x] run the project test suite; it must pass before Task 7

### Task 7: Divide the web page into markup, style, and script

**Files:**
- Create: `public/app.css`, `public/app.js`
- Modify: `public/index.html`, `test/theme.test.ts`, `test/server/server.test.ts`

- [x] move lines 9-226 of `index.html` (the `<style>` body, with both `:root` blocks) to `public/app.css`, and link it with `<link rel="stylesheet" href="/app.css">`
- [x] move lines 231-1044 (the `<script>` body) to `public/app.js`, and load it with `<script src="/app.js" defer></script>`
- [x] confirm that the server MIME map returns `text/css` and `text/javascript`, and add the entries if they are absent (both were already present in `src/server/http.ts`)
- [x] update `test/theme.test.ts` to parse the `:root` blocks out of `public/app.css` (that file is now `test/store/palettes.test.ts`)
- [x] update `test/server/server.test.ts` to look for the picker markup in `index.html` and the built-in ids in `app.js` or `app.css`, whichever holds them after the move (the picker and the ids are built in `app.js`; a new test asserts that `index.html` links both assets and holds no inline block)
- [x] add a test that gets `/app.css` and `/app.js` and asserts the status and the content type
- [x] run the project test suite; it must pass before Task 8

### Task 8: Remove the unnecessary comments

**Files:**
- Modify: every file in `src/` and `test/`

- [x] delete comments that repeat the code, and delete narrative or historical prose ("this used to", "earlier versions")
- [x] compress each long rationale block to one or two lines, and keep it only where the code is not obvious or where it guards an invariant
- [x] move the full reasoning that you remove into the Rules section of `agents.md`, so no invariant is lost (six new rules: the absent-verdict rule, the annotation record format, the path-splicing rule, untracked `lstat` handling, the two `git status` traps, and the `---`/`+++` hunk gate; plus a comment-policy rule)
- [x] keep a one-line JSDoc on each exported symbol (enforced by `test/comments.test.ts`)
- [x] confirm that the comment lines are below 20% of each file; every file in `src/` and `test/` is now under 20% (from 45-57% on the heaviest), with one documented exemption: `src/shared/log.ts` is 2/9, because two exported one-liners in a nine-line file cannot carry their JSDoc and stay under. `test/comments.test.ts` enforces the ceiling, the exemption list, the per-export JSDoc, and the ban on historical prose
- [x] run the project test suite; it must pass before Task 9

### Task 9: Rewrite the documents in Simplified Technical English

**Files:**
- Modify: `agents.md`, `README.md`, `.github/skills/*/SKILL.md`, `test/docs.test.ts`

- [x] rewrite `agents.md`: replace the module table with the new package tree, and rewrite the Rules in STE
- [x] rewrite `README.md` in STE: one topic per sentence, active voice, present tense, and a maximum of 20 words in a procedure sentence and 25 in a descriptive sentence
- [x] rewrite the prose in each `SKILL.md`; do not change the quoted command lines, because `test/skills.test.ts` parses them
- [x] update the module list in `test/docs.test.ts` to the new paths (the list is now derived: `documentedModules` parses the `## Modules` tree out of `agents.md` and compares it with `src/` on disk, so a new or moved module cannot leave the guide stale)
- [x] update every literal README assertion in `test/docs.test.ts` that the STE rewrite changes (`**System**. It is a real choice`, `A missing config file is the normal first run, and revgate is silent`; `the history directory itself` and `the directory that holds config.json` survived the rewrite unchanged)
- [x] keep all flag names, exit codes, paths, and command examples exactly as they are; STE applies to the prose, not to the identifiers
- [x] run the project test suite; it must pass before Task 10 (381 tests, 0 failures)

### Task 10: Verify acceptance criteria

- [x] run `npm run build`; `tsc` must report no error
- [x] run `npm test`; the full suite must pass (381 tests, 373 pass, 0 fail, 8 skipped)
- [x] confirm that `dist/index.js` exists and that `node dist/index.js review --help` prints the help text
- [x] run `node dist/index.js review --no-open` in a throwaway repo, and confirm that the server serves `/`, `/app.css`, and `/app.js` (all 200; `text/html`, `text/css`, `text/javascript`; this proves the `PUBLIC_DIR` extra `".."` from Task 4 is correct against the built tree)
- [x] confirm that no file in `src/` is more than 300 lines (largest is `src/server/index.ts` at 263)
- [x] confirm that no file outside `src/git/` calls `execFile("git", ...)` (the only `execFile` is in `src/git/exec.ts`; `src/server/browser.ts` spawns the browser opener, not git)

### Task 11: Update the documentation

- [x] confirm that `agents.md` lists every file in the new `src/` tree (all 25 modules; `documentedModules` in `test/docs.test.ts` parses the `## Modules` tree and compares it with `src/` on disk, so the check is derived, not hand-kept)
- [x] confirm that `README.md` still documents every `--help` flag, every exit code, and the history and theme paths (the Options table holds each of the 12 flags that `helpText()` names, the Exit codes table holds `0`, `10`, `1` and `2`, and the README gives `<historyDir>/<repo-name>/<timestamp>.md` with `$REVGATE_HISTORY_DIR` and `~/.revgate/config.json` with `$REVGATE_CONFIG_DIR`)
- [x] confirm that the Develop section of `README.md` describes the new package layout (a table of the seven packages, plus `src/index.ts` at the root, the mirrored `test/` shape, and the three `public/` files)
- [x] run `npm test` one more time, because a document-only edit can fail `test/docs.test.ts` (381 tests, 373 pass, 0 fail, 8 skipped)

## Post-completion (manual)

- Review the STE rewrite of `README.md` by hand. A style rewrite is easy to make correct and dull; check that it is still readable.
- Confirm in a browser that the review page looks the same after the asset split, in the dark theme and in the light theme.
