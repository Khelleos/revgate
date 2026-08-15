---
name: revgate-plan
description: Open a human review gate for a plan or a design document before you implement it. Use it when the user says "review my plan", "gate this plan", "let me sign off on the plan first", or when you wrote a plan file and want approval before you start to edit code.
argument-hint: "<file> — the path to the plan or design document in markdown to review"
---

# revgate-plan

`revgate review --plan <file>` opens the same review page as
[revgate-review](../revgate-review/SKILL.md), but over a **plan document**
instead of a git diff. revgate renders the plan as a numbered document. The user
comments on it line by line, and their comments come back to you as annotations
on stdout.

## When to use this instead of the hook

revgate also ships a `preToolUse` hook that gates the built-in plan mode of
Copilot automatically. That hook fires only when the agent calls
`exit_plan_mode`. Thus it never fires when:

- the user is not in Copilot plan mode at all;
- you wrote a plan to a file (`docs/plans/*.md`, `DESIGN.md`, a draft issue) as
  ordinary work, rather than through plan mode;
- the user wants a second review of a plan that somebody approved once;
- revgate is installed but the plan hook is not, which is a skills-only install.

Run this skill explicitly in each of those cases.

## Run the plan review

Write the plan to a file first, then review that file. Always pass
`--exit-code-on-comments`:

```bash
revgate review --plan docs/plans/rate-limiting.md --exit-code-on-comments
```

The path is optional. Without one, revgate falls back to `$REVGATE_PLAN_FILE`:

```bash
revgate review --plan --exit-code-on-comments
```

If neither is set, or revgate cannot read the file, or the file is empty, the
command exits `2`. It does not review the diff instead. There is no silent
fallback: exit `0` from this skill means that a person approved a plan, thus it
must never be reachable without one.

`--no-open` (do not open the browser), `--output plan-review.md` (write the
annotations to a file), `--history-dir` and `--no-history` work exactly as they
do for a diff review. The scope flags (`--staged`, `--include`, `--exclude`,
refs) do not apply to a plan, and revgate rejects them with exit `2`.

The command blocks until the user submits in the browser, and to close the tab
does not end it. Thus warn the user that you open a review, and set a generous
timeout.

## Read the exit code

| Exit | Meaning | What you do |
| --- | --- | --- |
| `10` | revgate captured comments. They are on stdout, or in the `--output` file if you passed one. Read the `# revgate review:` line for the verdict: `REQUEST CHANGES` means that the plan needs another pass, and `APPROVED` means that the person signed off *and* left notes | Apply each comment to the plan file. On `REQUEST CHANGES`, ask whether to review again before you implement. On `APPROVED`, say what you changed and go ahead |
| `0` | The person approved the plan | Start to implement it |
| `2` | Bad usage: an unknown flag, a scope flag alongside `--plan`, or no plan text behind `--plan`. The last one covers a path that revgate cannot read, an empty file, and an unset `$REVGATE_PLAN_FILE` | Correct the command line one time, then run it again |
| `1` | revgate captured no verdict. The review stopped, thus nobody approved the plan | Tell the user that the review did not complete. Do not start to implement |
| anything else | A real error | Report it to the user. **Do not retry in a loop** |

## Consume the annotations

The output uses the same record format as a diff review. It carries `mode: plan`
in the header, and its line numbers point into the plan document:

```text
# revgate review: REQUEST CHANGES
mode: plan
files: 1
comments: 1

Good direction, but the rollout is missing.

## Plan:12 (+)
Say what happens when Redis is down.
```

revgate reviews a plan as one synthetic file, and that file always has the name
`Plan`. Thus each record header reads `## Plan:<line>`. The number is the line
in the plan file that you passed, and it counts from 1.

Each `## ` line names an exact line in the plan document, or a `START-END`
range. Everything below it, up to the next `## ` line, is the body of that
comment, and each continuation line is indented by one space.

Apply each comment to the plan file itself, then tell the user what you changed
for each comment. Do not start to implement a plan whose report says
`# revgate review: REQUEST CHANGES`. Wait until a person approves the revised
plan. Exit `10` on its own means only that comments came back, and an approval
that carries notes is still an approval.
