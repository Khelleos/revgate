# revgate

Tiny local web UI that gates Copilot agent stops so you can review them like a GitHub PR.

Pipe Copilot's `agentStop` event to revgate, review the turn's diffs in your
browser, leave comments or an overall decision, and revgate returns a compact
decision JSON to stdout for Copilot to consume. Approve and the agent stops;
request changes and your feedback becomes the agent's next prompt.

## Requirements

- **Node.js ≥ 18** on your PATH (`node --version`). The installer builds from
  source, so npm comes with it. No other runtime dependencies.
- **Git** — to clone this repo, and so revgate can read the working-tree diff of
  the repo you're reviewing.
- **A GitHub Copilot surface that fires the `agentStop` hook** — Copilot CLI, or
  VS Code Copilot agent mode. revgate is a *gate*: it only runs when that hook
  fires. (The JetBrains plugin is not known to support these hooks.)
- **A web browser** for the review UI (served locally on `127.0.0.1`, random port).

## Install

Clone, then run the installer in PowerShell. It builds revgate and wires the
Copilot hook for you — no hand-editing paths.

```powershell
git clone <repo-url> revgate
cd revgate
.\install.ps1
```

The installer asks how to enable revgate:

- **Globally** (recommended) — gates every repository you work in, via
  `%USERPROFILE%\.copilot\hooks\revgate.json`.
- **One repository** — gates a single repo, via its `.github\hooks\revgate.json`.

Non-interactive / scripted:

```powershell
.\install.ps1 -Global
.\install.ps1 -Repo C:\path\to\project
.\install.ps1 -Timeout 1800        # review timeout in seconds (default 3600)
```

> If PowerShell blocks the script, either unblock it once with
> `Unblock-File .\install.ps1`, or run it in a single session with
> `powershell -ExecutionPolicy Bypass -File .\install.ps1`.

## Verify

```powershell
node dist\index.js --demo            # diff review against your working tree
node dist\index.js --demo --plan     # plan review, using a bundled sample plan
```

This opens the review UI directly so you can confirm it works before relying on
the hook.

## Plan review

revgate can also gate the agent *before* it writes code — reviewing the **plan**
it proposes instead of the resulting diff. Approve and the agent proceeds with
the plan; request changes and your feedback becomes the agent's next prompt, so
it revises the plan first.

This runs off Copilot's **`preToolUse`** hook via a dedicated entry point,
`revgate copilot-plan`. The installer wires it alongside the diff gate, so with a
normal install you get **both**: a plan gate up front and a diff gate at the end
of the turn.

How it works:

1. In Copilot CLI, `Shift+Tab` enters plan mode; the agent drafts a plan and
   calls the `exit_plan_mode` tool to leave it.
2. `preToolUse` fires *before* that tool runs. The hook has no matcher and fires
   for every tool, so `revgate copilot-plan` self-filters: any tool other than
   `exit_plan_mode` is passed straight through (`permissionDecision: allow`).
3. For `exit_plan_mode`, revgate resolves the plan text — from the hook payload
   (`toolArgs.plan` / `tool_input.plan`) if present, otherwise from
   `~/.copilot/session-state/<sessionId>/plan.md`, where Copilot writes it — and
   opens the review UI.
4. **Approve** → `permissionDecision: allow`, the tool runs and the agent
   proceeds. **Request changes** → `permissionDecision: deny`, and your review is
   handed back as the reason so the agent revises the plan.

The plan hook **fails open**: if revgate can't find plan text, is interrupted, or
errors, it allows the tool through rather than blocking the agent. (Copilot fails
a `preToolUse` hook *closed* on a non-zero exit, so revgate always emits an
explicit `allow` and exits 0.)

The review UI, line comments, and approve / request-changes verdict are identical
to diff review — each plan line is commentable, and your notes are quoted back to
the agent.

> Manual / non-Copilot use: `revgate --plan <file>` (or the `REVGATE_PLAN_FILE`
> env var) reviews a markdown plan file directly and emits the `agentStop`-style
> decision, handy for testing the plan UI outside a hook.

### Install as a Copilot plugin

The installer above already writes both hooks. If you instead want to distribute
revgate as a Copilot CLI **plugin** (so users install it with `/plugin` rather
than running the installer), this repo ships a plugin manifest:

- `.github/plugin/marketplace.json` — the marketplace manifest
- `copilot-plugin/plugin.json` + `copilot-plugin/hooks.json` — the plan-gate plugin

```
/plugin marketplace add <owner>/revgate
/plugin install revgate-copilot@revgate
```

The plugin's hook calls `revgate copilot-plan`, so `revgate` must be on your PATH
(e.g. `npm install -g` this repo, or `npm link`). The `install.ps1` path instead
pins the absolute `node dist/index.js` command and needs nothing on PATH.

## Uninstall

```powershell
.\install.ps1 -Uninstall               # global
.\install.ps1 -Uninstall -Repo <path>  # a single repository
```

## Develop

```bash
npm install
npm run build       # compile TypeScript to dist/
npm run demo        # run the UI against your working tree without building
```

The `hooks/revgate.json` file is a reference template; the installer generates a
copy with the correct absolute path to this clone's `dist/index.js`.
