<#
  revgate installer (Windows / PowerShell) — build revgate, put the `revgate`
  CLI on PATH, install the /revgate-review and /revgate-plan skills, and wire
  the one automatic hook: the global preToolUse plan gate. Everything else
  runs on demand.

    .\install.ps1                    # CLI + skills + global plan hook
    .\install.ps1 -Timeout 900      # same, with a shorter review timeout
    .\install.ps1 -Uninstall        # remove the global hook AND the skills
#>
[CmdletBinding()]
param(
  [int]$Timeout = 3600,
  [switch]$Uninstall,
  [switch]$SkipBuild,
  [switch]$Help
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Entry = Join-Path $ScriptDir "dist\index.js"
$HookName = "revgate.json"
$SkillSource = Join-Path $ScriptDir ".github\skills"
$SkillTarget = Join-Path $env:USERPROFILE ".copilot\skills"

function Show-Usage {
  Write-Host @"
revgate installer — manual-first: installs the /revgate-review and /revgate-plan
skills, plus one automatic exception, the preToolUse plan gate.

Usage:
  .\install.ps1 [-Timeout <sec>] [-SkipBuild]
  .\install.ps1 -Uninstall
  .\install.ps1 -Help

Options:
  -Timeout <sec>   Seconds revgate may wait for your plan review (default 3600).
  -SkipBuild       Wire the hook to the existing dist/ instead of running any
                   npm step — install, build, and the global CLI install (CI,
                   tests, repeat installs). The check that dist\index.js exists
                   still applies.
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

function Assert-Node {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Write-Error "Node.js is not on PATH. Install Node >= 18, then re-run."
    exit 1
  }
  $major = [int](& node -p "process.versions.node.split('.')[0]")
  if ($major -lt 18) {
    Write-Error "Node $major detected; revgate needs Node >= 18."
    exit 1
  }
}

function Invoke-Build {
  if ($SkipBuild) {
    Write-Host "Skipping npm install / build (-SkipBuild)."
  } else {
    Write-Host "Installing dependencies…"
    Push-Location $ScriptDir
    try {
      # $ErrorActionPreference does not apply to native commands, so check
      # $LASTEXITCODE by hand. Test-Path alone is not enough: a stale dist/ from
      # an earlier build passes it, and we would then wire a preToolUse hook —
      # which fails closed — to code that no longer compiles.
      & npm install --silent
      if ($LASTEXITCODE -ne 0) { Write-Error "npm install failed (exit $LASTEXITCODE)"; exit 1 }
      Write-Host "Building…"
      & npm run build --silent
      if ($LASTEXITCODE -ne 0) { Write-Error "npm run build failed (exit $LASTEXITCODE)"; exit 1 }
    } finally {
      Pop-Location
    }
  }
  # Outside the branch on purpose: -SkipBuild may skip the build, never this. A
  # hook wired to a missing dist/index.js is a preToolUse hook that fails
  # *closed*, denying every tool call.
  if (-not (Test-Path $Entry)) {
    Write-Error "no build at $Entry — run without -SkipBuild"
    exit 1
  }
}

function Install-Bin {
  # The skills shell out to `revgate`, so the bin must resolve on PATH — and
  # asking the user to run `npm install -g .` themselves is an extra step that
  # gets skipped. npm's global bin directory is already on PATH from the Node
  # install, so one global install from this clone is all it takes. `prepare`
  # re-runs tsc during it, which is why this comes after Invoke-Build: the
  # local node_modules it compiles with must already exist.
  #
  # -SkipBuild skips this too, not just the build: the test suite runs this
  # script against a sandboxed USERPROFILE, but `npm install -g` writes to the
  # real npm prefix — it must never fire from a test.
  if ($SkipBuild) {
    Write-Host "Skipping the global CLI install (-SkipBuild)."
    return
  }
  Write-Host "Putting the ``revgate`` CLI on PATH (npm install -g)…"
  Push-Location $ScriptDir
  try {
    & npm install -g . --silent
    if ($LASTEXITCODE -ne 0) { Write-Error "npm install -g failed (exit $LASTEXITCODE)"; exit 1 }
  } finally {
    Pop-Location
  }
}

function Write-Hook([string]$target, [string]$entry) {
  $dir = Split-Path -Parent $target
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  # Forward slashes so `node` accepts the path from both PowerShell and Git Bash.
  $entryFwd = $entry -replace '\\', '/'
  # `$` and `` ` `` are legal in Windows directory names, and both hook shells
  # expand them inside double quotes at hook RUN time — an unescaped `$` bends
  # the path, fails the existence guard below, and silently disables the plan
  # gate on every session. Escape per shell; the bash escape is a backslash,
  # written doubled because the value lands inside a JSON string.
  $entryBash = $entryFwd -replace '([$`])', '\\$1'
  $entryPs = $entryFwd -replace '([$`])', '`$1'
  $json = @"
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "type": "command",
        "comment": "revgate: intercept exit_plan_mode and review the proposed plan before Copilot implements it. Approve -> the plan proceeds; request changes -> the agent revises. Other tools pass straight through. This is revgate's ONLY automatic hook - diff review runs on demand via /revgate-review or 'revgate review'. Timeout fails open, and so does a missing build: preToolUse fails CLOSED on a non-zero exit, so if this clone is moved or dist/ is cleaned the unguarded command would deny EVERY tool call in every session until the JSON is hand-edited.",
        "bash": "if [ -f \"$entryBash\" ]; then node \"$entryBash\" copilot-plan; else echo '{\"permissionDecision\":\"allow\"}'; fi",
        "powershell": "if (Test-Path \"$entryPs\") { node \"$entryPs\" copilot-plan } else { '{\"permissionDecision\":\"allow\"}' }",
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
    Write-Host "  Fix it from this clone with: npm install -g .   (or: npm link)"
  }
  Write-Host "  In Copilot CLI run /skills reload, then /revgate-review."
}

function Uninstall-Skills {
  # Uninstall reads the INSTALLED skills, not the source tree: someone removing
  # revgate may well have moved or deleted this checkout, and Get-SkillNames
  # hard-errors when .github\skills is gone — which would leave the installed
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
  Assert-Node
  Invoke-Build
  Install-Bin

  $target = Get-HookTarget
  $entryFwd = ($Entry -replace '\\', '/')
  Write-Hook $target $Entry

  Write-Host ""
  Install-Skills
  Write-Host "OK  revgate installed."
  Write-Host "  Hook:  $target"
  Write-Host "  Runs:  node `"$entryFwd`" copilot-plan"
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
  # The global CLI is left in place — this script must stay runnable from a
  # deleted checkout, and npm owns that install anyway. Point at the command
  # instead of running it.
  if (Get-Command revgate -ErrorAction SilentlyContinue) {
    Write-Host "The ``revgate`` CLI is still on PATH; remove it with: npm uninstall -g revgate"
  }
}

if ($Help) { Show-Usage; exit 0 }
if ($Uninstall) { Invoke-Uninstall } else { Invoke-Install }
