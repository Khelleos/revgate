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
node dist\index.js --demo
```

This opens the review UI directly so you can confirm it works before relying on
the hook.

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
