<#
  revgate installer (Windows / PowerShell) — put the `revgate` CLI on PATH,
  install the /revgate-review and /revgate-plan skills, and wire the one
  automatic hook: the global preToolUse plan gate. Everything else runs on
  demand.

    .\install.ps1                    # CLI + skills + global plan hook
    .\install.ps1 -Timeout 900      # same, with a shorter review timeout
    .\install.ps1 -Uninstall        # remove the global hook AND the skills
#>
[CmdletBinding()]
param(
  [int]$Timeout = 3600,
  [switch]$Uninstall,
  [switch]$SkipInstall,
  [switch]$Help
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HookName = "revgate.json"
$SkillSource = Join-Path $ScriptDir "assets\skills"
$SkillTarget = Join-Path $env:USERPROFILE ".copilot\skills"
# Where `uv tool install` puts a console script on Windows.
$UvBinDir = Join-Path $env:USERPROFILE ".local\bin"

function Show-Usage {
  Write-Host @"
revgate installer — manual-first: installs the /revgate-review and /revgate-plan
skills, plus one automatic exception, the preToolUse plan gate.

Usage:
  .\install.ps1 [-Timeout <sec>] [-SkipInstall]
  .\install.ps1 -Uninstall
  .\install.ps1 -Help

Options:
  -Timeout <sec>   Seconds revgate may wait for your plan review (default 3600).
  -SkipInstall     Wire the hook to the revgate already on PATH instead of
                   running uv tool install (tests, repeat installs). The check
                   that the executable exists still applies.
  -Uninstall       Remove the global plan hook and the skills.
  -Help            Show this help.

A plain run installs everything: the CLI on PATH, both skills (into
`$env:USERPROFILE\.copilot\skills\), and the global plan gate
(`$env:USERPROFILE\.copilot\hooks\$HookName).
"@
}

function Get-HookTarget {
  return (Join-Path (Join-Path $env:USERPROFILE ".copilot\hooks") $HookName)
}

function Assert-Uv {
  # No Python check: `uv tool install` reads `requires-python` from
  # pyproject.toml and downloads a managed CPython 3.14 when the machine has
  # none. uv itself is the only prerequisite.
  $uv = Get-Command uv -ErrorAction SilentlyContinue
  if (-not $uv) {
    Write-Error "uv is not on PATH. Install it from https://docs.astral.sh/uv/, then re-run."
    exit 1
  }
}

function Install-Bin {
  # The skills shell out to `revgate`, so the bin must resolve on PATH — and
  # asking the user to run `uv tool install` themselves is an extra step that
  # gets skipped.
  #
  # -SkipInstall skips this: the installer may be run against a sandboxed
  # USERPROFILE, and `uv tool install` writes to the real one.
  if ($SkipInstall) {
    Write-Host "Skipping the CLI install (-SkipInstall)."
  } else {
    Write-Host "Putting the ``revgate`` CLI on PATH (uv tool install)…"
    Push-Location $ScriptDir
    try {
      # $ErrorActionPreference does not apply to native commands, so check
      # $LASTEXITCODE by hand.
      & uv tool install --force .
      if ($LASTEXITCODE -ne 0) { Write-Error "uv tool install failed (exit $LASTEXITCODE)"; exit 1 }
    } finally {
      Pop-Location
    }
  }

  # uv puts the console script here, and a fresh install adds the directory to
  # the *persisted* PATH — which this already-running session does not see. Put
  # it on the session PATH so the guard below, and everything after it, resolves.
  if (Test-Path $UvBinDir) {
    if (($env:PATH -split ';') -notcontains $UvBinDir) {
      $env:PATH = "$UvBinDir;$env:PATH"
    }
  }

  # Outside the branch on purpose: -SkipInstall may skip the install, never this.
  # A hook wired to a missing executable is a preToolUse hook that fails
  # *closed*, denying every tool call in every session.
  $cmd = Get-Command revgate -ErrorAction SilentlyContinue
  if (-not $cmd) {
    Write-Error "the ``revgate`` executable was not found after the install — refusing to wire a hook that would deny every tool call. Check ``uv tool install --force .`` and that $UvBinDir is on PATH."
    exit 1
  }
  return $cmd.Source
}

function Write-Hook([string]$target, [string]$entry) {
  $dir = Split-Path -Parent $target
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  # Forward slashes so the path is accepted from both PowerShell and Git Bash.
  $entryFwd = $entry -replace '\\', '/'
  # `$` and `` ` `` are legal in Windows directory names, and both hook shells
  # expand them inside double quotes at hook RUN time — an unescaped `$` bends
  # the path, fails the existence guard below, and silently disables the plan
  # gate on every session. Escape per shell; the bash escape is a backslash,
  # written doubled because the value lands inside a JSON string.
  $entryBash = $entryFwd -replace '([$`])', '\\$1'
  $entryPs = $entryFwd -replace '([$`])', '`$1'
  # The PowerShell branch needs the call operator: a quoted path on its own line
  # is just a string literal, so the gate would print its own path and allow.
  $json = @"
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "type": "command",
        "comment": "revgate: intercept exit_plan_mode and review the proposed plan before Copilot implements it. Approve -> the plan proceeds; request changes -> the agent revises. Other tools pass straight through. This is revgate's ONLY automatic hook - diff review runs on demand via /revgate-review or 'revgate review'. Timeout fails open, and so does a missing executable: preToolUse fails CLOSED on a non-zero exit, so if revgate is uninstalled the unguarded command would deny EVERY tool call in every session until the JSON is hand-edited.",
        "bash": "if [ -x \"$entryBash\" ]; then \"$entryBash\" plan; else echo '{\"permissionDecision\":\"allow\"}'; fi",
        "powershell": "if (Test-Path \"$entryPs\") { & \"$entryPs\" plan } else { '{\"permissionDecision\":\"allow\"}' }",
        "timeoutSec": $Timeout
      }
    ]
  }
}
"@
  # Write UTF-8 WITHOUT a BOM — Set-Content -Encoding utf8 adds one on PS 5.1,
  # which strict JSON parsers reject.
  [System.IO.File]::WriteAllText($target, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-SkillNames {
  if (-not (Test-Path $SkillSource)) {
    Write-Error "no skills found at $SkillSource"
    exit 1
  }
  return Get-ChildItem -Path $SkillSource -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName "SKILL.md") } |
    ForEach-Object { $_.Name }
}

function Install-Skills {
  $names = @(Get-SkillNames)
  if ($names.Count -eq 0) {
    Write-Error "no SKILL.md files found under $SkillSource"
    exit 1
  }
  New-Item -ItemType Directory -Force -Path $SkillTarget | Out-Null
  foreach ($name in $names) {
    $dest = Join-Path $SkillTarget $name
    if (Test-Path $dest) { Remove-Item -Path $dest -Recurse -Force }
    Copy-Item -Path (Join-Path $SkillSource $name) -Destination $dest -Recurse -Force
    Write-Host "OK  installed skill /$name"
  }
  Write-Host "  Skills: $SkillTarget"
  # The skills shell out to `revgate`, so an install that leaves it off PATH
  # produces skills that fail on first use with "command not found". Say so
  # here rather than letting the user discover it inside Copilot.
  if (Get-Command revgate -ErrorAction SilentlyContinue) {
    Write-Host "  OK  ``revgate`` resolves on PATH."
  } else {
    Write-Warning "``revgate`` is not on PATH — the skills will fail until it is."
    Write-Host "  Fix it from this clone with: uv tool install --force ."
  }
  Write-Host "  In Copilot CLI run /skills reload, then /revgate-review."
}

function Uninstall-Skills {
  # Uninstall reads the INSTALLED skills, not the source tree: someone removing
  # revgate may well have moved or deleted this checkout, and Get-SkillNames
  # hard-errors when assets\skills is gone — which would leave the installed
  # skills stranded with no way to remove them.
  $names = @()
  if (Test-Path $SkillTarget) {
    $names = @(Get-ChildItem -Path $SkillTarget -Directory |
      Where-Object { $_.Name -like "revgate-*" } |
      ForEach-Object { $_.Name })
  }
  if ($names.Count -eq 0) {
    Write-Host "no revgate skills installed under $SkillTarget"
    return
  }
  foreach ($name in $names) {
    $dest = Join-Path $SkillTarget $name
    if (Test-Path $dest) {
      Remove-Item -Path $dest -Recurse -Force
      Write-Host "OK  removed $dest"
    } else {
      Write-Host "no skill installed at $dest"
    }
  }
}

function Invoke-Install {
  # One route: the CLI, the skills, and the global plan gate always install
  # together. The skills are precisely the thing that shells out to `revgate`,
  # so an install without the CLI would fail on first use.
  Assert-Uv
  $entry = Install-Bin

  $target = Get-HookTarget
  $entryFwd = ($entry -replace '\\', '/')
  Write-Hook $target $entry

  Write-Host ""
  Install-Skills
  Write-Host "OK  revgate installed."
  Write-Host "  Hook:  $target"
  Write-Host "  Runs:  & `"$entryFwd`" plan"
  Write-Host ""
  Write-Host "revgate is manual-first, with one automatic exception:"
  Write-Host "  * On demand - /revgate-review and /revgate-plan in Copilot CLI, or"
  Write-Host "                ``revgate review`` in a terminal, whenever you ask."
  Write-Host "  * Automatic - Plan gate (preToolUse): when the agent leaves plan mode,"
  Write-Host "                review its plan before it writes code. Request changes"
  Write-Host "                -> it revises. Nothing else fires on its own."
  Write-Host "In both, your comments become the agent's next prompt."
  Write-Host ""
  Write-Host "Uninstall:  .\install.ps1 -Uninstall"
}

function Invoke-Uninstall {
  # Uninstall mirrors the install: the global hook and the skills go together.
  $target = Get-HookTarget
  if (Test-Path $target) {
    Remove-Item -Path $target -Force
    Write-Host "OK  removed $target"
  } else {
    Write-Host "no revgate hook found at $target"
  }
  Uninstall-Skills
  # The CLI is left in place — this script must stay runnable from a deleted
  # checkout, and uv owns that install anyway. Point at the command instead of
  # running it.
  if (Get-Command revgate -ErrorAction SilentlyContinue) {
    Write-Host "The ``revgate`` CLI is still on PATH; remove it with: uv tool uninstall revgate"
  }
}

if ($Help) { Show-Usage; exit 0 }
if ($Uninstall) { Invoke-Uninstall } else { Invoke-Install }
