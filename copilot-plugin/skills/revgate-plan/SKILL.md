---
name: revgate-plan
description: Open a human review gate for a plan or design document before implementing it. Use when the user says "review my plan", "gate this plan", "let me sign off on the plan first", or when you have written a plan file and want approval before you start editing code.
argument-hint: "<file> — path to the plan/design markdown document to review"
---

# revgate-plan

`revgate review --plan <file>` opens the same review UI as
[revgate-review](../revgate-review/SKILL.md), but over a **plan document** instead
of a git diff: the plan is rendered as a numbered document the user can comment on
line by line, and their comments come back to you as annotations on stdout.

## When to use this instead of the hook

revgate also ships a `preToolUse` hook that gates Copilot's built-in plan mode
automatically. That hook only fires when the agent calls `exit_plan_mode` — so it
never fires when:

- the user is not in Copilot plan mode at all;
- you wrote a plan to a file (`docs/plans/*.md`, `DESIGN.md`, an issue draft) as
  ordinary work rather than through plan mode;
- the user wants a second review of a plan that was already approved once;
- revgate is installed but the plan hook is not (a skills-only install).

In all of those cases, run this skill explicitly.

## Run the plan review

Write the plan to a file first, then review that file. Always pass
`--exit-code-on-comments`:

```bash
revgate review --plan docs/plans/rate-limiting.md --exit-code-on-comments
```

The path is optional — without one, revgate falls back to `$REVGATE_PLAN_FILE`:

```bash
revgate review --plan --exit-code-on-comments
```

If neither is set — or the file cannot be read, or is empty — the command exits
`2` rather than reviewing the diff instead. There is no silent fallback: exit `0`
from this skill means a human approved a plan, so it must never be reachable
without one.

`--no-open` (skip auto-opening the browser), `--output plan-review.md` (write the
annotations to a file), `--history-dir` and `--no-history` work exactly as they do
for a diff review. Scope flags (`--staged`, `--include`, `--exclude`, refs) do not
apply to a plan and are rejected with exit `2` if you pass them.

The command blocks until the user submits in the browser — closing the tab does
not end it — so warn them you are opening a review and set a generous timeout.

## Read the exit code

| Exit | Meaning | What you do |
| --- | --- | --- |
| `10` | Comments were captured; they are on stdout, or in the `--output` file if you passed one. Read the `# revgate review:` line for the verdict — `REQUEST CHANGES` means the plan needs another pass, `APPROVED` means the human signed off *and* left notes | Apply every comment to the plan file. On `REQUEST CHANGES`, ask whether to review again before implementing; on `APPROVED`, say what you changed and go ahead |
| `0` | The plan is approved | Start implementing it |
| `2` | Bad usage — an unknown flag, a scope flag alongside `--plan`, or no plan text behind `--plan` (a path that cannot be read, an empty file, or no `$REVGATE_PLAN_FILE`) | Fix the command line once, then re-run |
| `1` | No verdict was captured — the review was interrupted, so the plan was **not** approved | Tell the user the review did not complete; do not start implementing |
| anything else | A real error | Report it to the user; **do not retry in a loop** |

## Consume the annotations

The output uses the same record format as a diff review, with `mode: plan` in the
header and line numbers pointing into the plan document:

```text
# revgate review: REQUEST CHANGES
mode: plan
files: 1
comments: 1

Good direction, but the rollout is missing.

## Plan:12 (+)
Say what happens when Redis is down.
```

A plan is reviewed as a single synthetic file always named `Plan`, so every
record header reads `## Plan:<line>` — the number is the line in the plan file
you passed, counting from 1.

Each `## ` line names an exact line (or `START-END` range) in the plan document;
everything beneath it up to the next `## ` is that comment's body, with
continuation lines indented by one space.

Apply every comment to the plan file itself, then tell the user what you changed
per comment. Do not start implementing a plan whose report says
`# revgate review: REQUEST CHANGES` until the revised plan has been approved —
exit `10` on its own only means comments came back, and an approval carrying
notes is still an approval.
