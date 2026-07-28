---
name: revgate-review
description: Open a human review gate for code changes and act on the reviewer's line comments. Use when the user says "review my changes", "open a review", "gate this diff", "let me review this before you continue", or asks for a review of a branch, a range of commits, or the staged changes.
argument-hint: "[<refs>|<path>] — optional scope: nothing (working tree), a single ref (HEAD~3), two refs (main feature), a range (main..feature), --staged, or a path prefix (src) which means --include src"
---

# revgate-review

`revgate review` opens a local, GitHub-style review UI in the user's browser, waits
for them to leave line comments and a verdict, then prints those comments back to
you as markdown annotations on stdout.

This is a **blocking, human-in-the-loop** step: the command does not return until
the user submits the review in the browser. Closing the tab does not end it —
only submitting does, or interrupting the command. Tell the user you are opening
a review before you run it, and set a generous timeout.

## Run the review

Always pass `--exit-code-on-comments` so the exit code tells you whether there is
work to do:

```bash
revgate review --exit-code-on-comments
```

Scope it when the user asked for something narrower than "everything I have not
committed yet":

```bash
revgate review --staged --exit-code-on-comments
revgate review HEAD~3 --exit-code-on-comments
revgate review main feature --exit-code-on-comments
revgate review main..feature --exit-code-on-comments
revgate review main...feature --exit-code-on-comments
```

A positional argument is always a **git ref**, never a path — `revgate review src`
looks for a commit called `src` and exits 2. Narrow by path with `--include`
instead: an argument like `src` or `src/api` means `--include src`.

Path filters compose the same way (`--include` narrows first, then `--exclude`
removes); both are repeatable and both take a path prefix, matched at directory
boundaries (`--exclude src/generated` keeps `src/generated-old.ts`). Prefixes are
relative to the **repository root**, not to your current directory — from `pkg/`
you still write `--include pkg/lib`, not `--include lib`:

```bash
revgate review --include src --exit-code-on-comments
revgate review main..feature --include src --exit-code-on-comments
revgate review --include src --include public --exclude src/generated --exit-code-on-comments
```

Other flags worth knowing: `--output review.md` writes the annotations to a file
instead of stdout, `--no-open` skips auto-opening the browser, `--history-dir` and
`--no-history` control where (or whether) the review is archived.

`--exit-code-on-comments`, `--no-history`, `--no-open`, `--staged` and `--demo`
are switches that take **no value**. Writing `--no-history=false` is a usage
error (exit 2), not "keep the history" — omit the flag to get the default.
Conversely, a flag that takes a value rejects an empty one: `-o ""` or
`-I "$SCOPE"` with the variable unset is a usage error (exit 2), not "no output
file" / "no filter". Check the variable before you interpolate it.

Every one of these flags is only valid **after** `revgate review`. Dropping the
subcommand is bad usage (exit 2) — bare `revgate` is not a command, so a typo
can never open a review or forge a clean one.

## Read the exit code

| Exit | Meaning | What you do |
| --- | --- | --- |
| `10` | Comments were captured; the annotations are on stdout, or in the `--output` file if you passed one | Address every one, then report back |
| `0` | Approved with nothing to act on, or nothing to review in this scope — **or** comments were captured on a run without `--exit-code-on-comments` | Read the `# revgate review:` line before you continue; on `APPROVED` with no records, say so and do not re-run |
| `2` | Bad usage — an unknown flag, a mistyped subcommand, a value on a valueless switch, a ref that does not resolve, a working directory that is not a git repository, or `NOTHING IN SCOPE`: your `--include`/`--exclude` prefixes removed every changed file, so nothing was reviewed | Fix the command line or the directory once, then re-run |
| `2` + `SCAN FAILED` | Listing untracked files failed, so every new file is missing from the diff and there was nothing left to review. **Not** an approval | Read git's reason on stderr and tell the user; unlike the other exit-2 causes, retrying once is reasonable here |
| `2` + `PATHS DROPPED` | Every changed file was dropped because its path contains a line break — such a path is never rendered, so nothing was reviewed. **Not** an approval | Tell the user which files to rename (the paths are on stderr); retrying without renaming them changes nothing |
| `1` | No verdict was captured — the review was interrupted, so nobody approved anything | Tell the user the review did not complete; **do not treat it as an approval** |
| anything else | A real error | Report it to the user; **do not retry in a loop** |

Never re-run the review just because you did not like the verdict — each run costs
the user another round of manual reviewing.

## Consume the annotations

Exit `10` means a report in this format is on stdout — or in the `--output` file,
if you passed one, in which case stdout is normally empty and you read that file
instead. If revgate could not write that file it says so on stderr and prints the
report to stdout anyway, so the reviewer's verdict is never lost:

```text
# revgate review: REQUEST CHANGES
scope: main..feature
branch: feature
files: 2
comments: 2

The error handling needs another pass.

## src/app.ts:12-13 (+)
Extract this into a helper.
 It is duplicated in server.ts.

## src/git.ts:40 (-)
Why was this guard removed?

## README.md
This file needs a section on the new flag.
```

How to read it:

- The leading section is the reviewer's overall verdict and summary. Treat the
  summary as context for the records, not as a separate task list.
- `scope:` is a human-readable label, not a command line you can re-run:
  `working tree vs HEAD`, `staged changes`, `HEAD~3 vs working tree`, or
  `main..feature`, with `[+<include> -<exclude>]` appended when path filters
  applied. A plan review has no diff scope, so it emits `mode: plan` and no
  `scope:` line at all.
- Every `## ` line starts one record and names an **exact location**. Everything
  beneath it, up to the next `## ` line, is that comment's body. Continuation
  lines are indented by one space — strip that space when reading them. The first
  line of a body is flush, except when it starts with `#` (which would otherwise
  open a bogus record), in which case it is indented too.
- `## path:LINE (+)` is one line on the **new** side of the diff;
  `## path:START-END (+)` is a range; `(-)` means the **old** (pre-change) side, so
  the comment is about what was removed;
  `## path` with no line number is a comment about the whole file.
- `untracked-scan: failed` or `dropped-paths: <n>` in the leading section means
  the diff the human reviewed was **incomplete** — new files could not be listed,
  or that many changed files carry a line break in their path and were never
  rendered. These lines appear on an ordinary `APPROVED` / `REQUEST CHANGES`
  report too, not only on the exit-2 ones above. Act on the records, then tell the
  user the review did not cover everything.

Then:

1. Treat each record as a directive against that exact location — open the file,
   go to that line, and do what the comment asks.
2. Address **every** record. If you disagree with one or cannot do it, say so
   explicitly rather than silently skipping it.
3. When you are done, summarize per record what you changed, so the user can see
   each comment was handled.
4. Offer to run the review again once the changes are in — but only run it if the
   user asks.

Reviews are also archived as markdown under `~/.revgate/history/<repo>/` (or
`$REVGATE_HISTORY_DIR`), so you can re-read a review whose output you lost.
