---
name: revgate-review
description: Open a human review gate for code changes, then act on the line comments of the reviewer. Use it when the user says "review my changes", "open a review", "gate this diff", "let me review this before you continue", or asks for a review of a branch, a range of commits, or the staged changes.
argument-hint: "[<refs>|<path>] — the optional scope: nothing (the working tree), one ref (HEAD~3), two refs (main feature), a range (main..feature), --staged, or a path prefix (src), which means --include src"
---

# revgate-review

`revgate review` opens a local review page in the browser of the user. The page
looks like GitHub. The command waits for the user to write line comments and a
verdict. It then prints those comments back to you, as markdown annotations on
stdout.

This is a **blocking, human-in-the-loop** step. The command does not return
until the user submits the review in the browser. To close the tab does not end
it. Only a submit ends it, or an interrupt of the command. Tell the user that
you open a review before you run it, and set a generous timeout.

## Run the review

Always pass `--exit-code-on-comments`. The exit code then tells you whether
there is work to do:

```bash
revgate review --exit-code-on-comments
```

Give the review a scope when the user asks for less than "everything that I did
not commit yet":

```bash
revgate review --staged --exit-code-on-comments
revgate review HEAD~3 --exit-code-on-comments
revgate review main feature --exit-code-on-comments
revgate review main..feature --exit-code-on-comments
revgate review main...feature --exit-code-on-comments
```

A positional argument is always a **git ref**, never a path. `revgate review src`
looks for a commit with the name `src`, and it exits 2. Use `--include` to
narrow by path instead: an argument such as `src` or `src/api` means
`--include src`.

The path filters compose in the same way: `--include` narrows first, then
`--exclude` removes. Both are repeatable, and both take a path prefix that
matches at a directory boundary (`--exclude src/generated` keeps
`src/generated-old.ts`). The prefixes are relative to the **repository root**,
not to your current directory. From `pkg/` you still write `--include pkg/lib`,
not `--include lib`:

```bash
revgate review --include src --exit-code-on-comments
revgate review main..feature --include src --exit-code-on-comments
revgate review --include src --include public --exclude src/generated --exit-code-on-comments
```

Other useful flags: `--output review.md` writes the annotations to a file
instead of stdout, `--no-open` does not open the browser, and `--history-dir`
and `--no-history` control where revgate archives the review, or whether it
archives it at all.

`--exit-code-on-comments`, `--no-history`, `--no-open` and `--staged` are
switches, and they take **no value**. `--no-history=false` is a usage error
(exit 2). It does not mean "keep the history". Omit the flag to get the default.
A flag that takes a value rejects an empty one: `-o ""` is a usage error
(exit 2), and so is `-I "$SCOPE"` with the variable unset. Neither means "no
output file" or "no filter". Check the variable before you put it into the
command line.

Each of these flags is valid only **after** `revgate review`. To drop the
subcommand is bad usage (exit 2). Bare `revgate` is not a command, thus a typo
can never open a review or forge a clean one.

## Read the exit code

| Exit | Meaning | What you do |
| --- | --- | --- |
| `10` | revgate captured comments. The annotations are on stdout, or in the `--output` file if you passed one | Act on each one, then report back |
| `0` | The reviewer approved with nothing to act on, or there was nothing to review in this scope. It also covers comments that revgate captured on a run without `--exit-code-on-comments` | Read the `# revgate review:` line before you continue. On `APPROVED` with no records, say so and do not run it again |
| `2` | Bad usage: an unknown flag, a mistyped subcommand, a value on a valueless switch, a ref that does not resolve, or a working directory that is not a git repository. It also covers `NOTHING IN SCOPE`: your `--include` and `--exclude` prefixes removed each changed file, thus revgate reviewed nothing | Correct the command line or the directory one time, then run it again |
| `2` with `SCAN FAILED` | The scan for untracked files failed. Each new file is missing from the diff, and nothing was left to review. This is **not** an approval | Read git's reason on stderr and tell the user. Unlike the other exit-2 causes, one more attempt is reasonable here |
| `2` with `PATHS DROPPED` | revgate dropped each changed file, because its path contains a line break. revgate never renders such a path, thus it reviewed nothing. This is **not** an approval | Tell the user which files to rename. The paths are on stderr. Another attempt without a rename changes nothing |
| `1` | revgate captured no verdict. The review stopped, thus nobody approved anything | Tell the user that the review did not complete. **Do not treat it as an approval** |
| anything else | A real error | Report it to the user. **Do not retry in a loop** |

Do not run the review again only because you do not like the verdict. Each run
costs the user one more manual review.

## Consume the annotations

Exit `10` means that a report in this format is on stdout. If you passed
`--output`, the report is in that file, stdout is normally empty, and you read
the file instead. If revgate could not write that file, it says so on stderr and
prints the report to stdout anyway, thus the verdict of the reviewer is never
lost:

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

## README.md:8 (+)
This section needs a note on the new flag.
```

How to read it:

- The leading section holds the overall verdict and the summary of the reviewer.
  Treat the summary as context for the records, not as a separate task list.
- `scope:` is a label for a person to read. It is not a command line that you can
  run again. Its values are `working tree vs HEAD`, `staged changes`,
  `HEAD~3 vs working tree`, or `main..feature`. revgate appends
  `[+<include> -<exclude>]` when path filters applied. A plan review has no diff
  scope, thus it writes `mode: plan` and no `scope:` line at all.
- Each `## ` line starts one record and names an **exact location**. Everything
  below it, up to the next `## ` line, is the body of that comment. Each
  continuation line is indented by one space, thus strip that space when you read
  it. The first line of a body is flush left. There is one exception: a first
  line that starts with `#` would open a bogus record, thus revgate indents that
  line too.
- `## path:LINE (+)` is one line on the **new** side of the diff.
  `## path:START-END (+)` is a range. `(-)` is the **old** side, before the
  change, thus the comment is about what the diff removed.
- `untracked-scan: failed` or `dropped-paths: <n>` in the leading section means
  that the diff which the person reviewed was **incomplete**. revgate could not
  list the new files, or that many changed files carry a line break in their path
  and revgate rendered none of them. These lines appear on an ordinary
  `APPROVED` or `REQUEST CHANGES` report too, not only on the exit-2 ones above.
  Act on the records. Then tell the user that the review did not cover
  everything.

Then:

1. Treat each record as a directive against that exact location. Open the file,
   go to that line, and do what the comment asks.
2. Act on **every** record. If you disagree with one, or you cannot do it, say
   so explicitly. Do not skip it in silence.
3. When you are ready, summarize per record what you changed. The user can then
   see that you handled each comment.
4. Offer to run the review again once the changes are in, but run it only if the
   user asks.

revgate also archives the reviews as markdown under
`~/.revgate/history/<repo>/`, or under `$REVGATE_HISTORY_DIR`. Thus you can read
a review again if you lost its output.
