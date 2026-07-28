<#
  revgate installer (Windows / PowerShell) — build revgate, install the
  /revgate-review and /revgate-plan skills, and wire the one automatic hook:
  the preToolUse plan gate. Everything else runs on demand.

    .\install.ps1                    # interactive: skills + plan hook (asks where)
    .\install.ps1 -Global           # skills + plan hook for every repo you work in
    .\install.ps1 -Repo <path>      # skills + plan hook for a single repository
    .\install.ps1 -Skills           # only the skills — fully manual, no hook
    .\install.ps1 -Uninstall        # remove the global hook AND the skills
    .\install.ps1 -Uninstall -Repo <path>   # remove that repo's hook
    .\install.ps1 -Uninstall -Skills        # remove only the skills
#>
[CmdletBinding()]
param(
  [switch]$Global,
  [string]$Repo,
  [int]$Timeout = 3600,
  [switch]$Skills,
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

# -Skills on its own scopes the run to skills; alongside -Global/-Repo it is
# redundant (a hook install always includes the skills) but accepted.
$SkillsOnly = ($Skills -and -not $Global -and -not $Repo)

function Show-Usage {
  Write-Host @"
revgate installer — manual-first: installs the /revgate-review and /revgate-plan
skills, plus one automatic exception, the preToolUse plan gate.

Usage:
  .\install.ps1 [-Global | -Repo <path>] [-Timeout <sec>] [-SkipBuild]
  .\install.ps1 -Skills
  .\install.ps1 -Uninstall [-Repo <path>] [-Skills]
  .\install.ps1 -Help

Options:
  -Global          Enable the plan gate for every repository you work in
                   (`$env:USERPROFILE\.copilot\hooks\$HookName). Skills included.
  -Repo <path>     Enable the plan gate for one repository
                   (<path>\.github\hooks\$HookName). Skills included.
  -Timeout <sec>   Seconds revgate may wait for your plan review (default 3600).
  -Skills          Install ONLY the skills into `$env:USERPROFILE\.copilot\skills\ —
                   fully manual, no hook is written.
  -SkipBuild       Wire the hook to the existing dist/ instead of running
                   npm install + npm run build (CI, tests, repeat installs). The
                   check that dist\index.js exists still applies.
  -Uninstall       Remove the plan hook and the skills. With -Repo <path>, remove
                   that repo's hook (add -Skills to remove the skills too); with
                   -Skills alone, remove only the skills.
  -Help            Show this help.

With no scope switch, the installer asks interactively where to put the plan gate.
"@
}

function Get-HookTarget([string]$scope) {
  if ($scope -eq "repo") {
    return (Join-Path (Join-Path $Repo ".github\hooks") $HookName)
  }
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

function Assert-Repo {
  if ([string]::IsNullOrWhiteSpace($Repo)) { Write-Error "-Repo requires a path"; exit 2 }
  if (-not (Test-Path $Repo)) { Write-Error "no such directory: $Repo"; exit 2 }
  if (-not (Test-Path (Join-Path $Repo ".git"))) {
    Write-Warning "$Repo has no .git — is it a repository? Continuing."
  }
}

function Write-Hook([string]$target, [string]$entry) {
  $dir = Split-Path -Parent $target
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  # Forward slashes so `node` accepts the path from both PowerShell and Git Bash.
  $entryFwd = $entry -replace '\\', '/'
  $json = @"
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "type": "command",
        "comment": "revgate: intercept exit_plan_mode and review the proposed plan before Copilot implements it. Approve -> the plan proceeds; request changes -> the agent revises. Other tools pass straight through. This is revgate's ONLY automatic hook - diff review runs on demand via /revgate-review or 'revgate review'. Timeout fails open, and so does a missing build: preToolUse fails CLOSED on a non-zero exit, so if this clone is moved or dist/ is cleaned the unguarded command would deny EVERY tool call in every session until the JSON is hand-edited.",
        "bash": "if [ -f \"$entryFwd\" ]; then node \"$entryFwd\" copilot-plan; else echo '{\"permissionDecision\":\"allow\"}'; fi",
        "powershell": "if (Test-Path \"$entryFwd\") { node \"$entryFwd\" copilot-plan } else { '{\"permissionDecision\":\"allow\"}' }",
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
  if ($SkillsOnly) {
    Install-Skills
    Write-Host ""
    Write-Host "No hook was installed - revgate is fully manual. Add the automatic plan"
    Write-Host "gate with .\install.ps1 -Global (or -Repo <path>)."
    return
  }

  Assert-Node
  Invoke-Build

  $scope = if ($Global) { "global" } elseif ($Repo) { "repo" } else { "" }
  if (-not $scope) {
    Write-Host ""
    Write-Host "Where should the automatic plan gate be enabled?"
    Write-Host "  1) Globally - every repository you work in   (recommended)"
    Write-Host "  2) One repository only"
    $choice = Read-Host "Choose [1/2] (1)"
    if ([string]::IsNullOrWhiteSpace($choice)) { $choice = "1" }
    switch ($choice) {
      "1" { $scope = "global" }
      "2" { $scope = "repo"; $script:Repo = Read-Host "Path to the repository to gate" }
      default { Write-Error "invalid choice"; exit 2 }
    }
  }
  if ($scope -eq "repo") { Assert-Repo }

  $target = Get-HookTarget $scope
  $entryFwd = ($Entry -replace '\\', '/')
  Write-Hook $target $Entry

  Write-Host ""
  Install-Skills
  Write-Host "OK  revgate installed."
  Write-Host "  Hook:  $target"
  Write-Host "  Runs:  node `"$entryFwd`" copilot-plan"
  Write-Host ""
  Write-Host "Try it now (opens the review UI in your browser):"
  Write-Host "  node `"$entryFwd`" review --demo            # diff review"
  Write-Host "  node `"$entryFwd`" review --demo --plan     # plan review"
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
  if ($SkillsOnly) {
    Uninstall-Skills
    return
  }

  $scope = if ($Repo) { "repo" } else { "global" }
  if ($scope -eq "repo") { Assert-Repo }
  $target = Get-HookTarget $scope
  if (Test-Path $target) {
    Remove-Item -Path $target -Force
    Write-Host "OK  removed $target"
  } else {
    Write-Host "no revgate hook found at $target"
  }
  # A plain -Uninstall mirrors a plain install (hook + skills). A repo-scoped
  # uninstall touches only that repo unless -Skills says otherwise: the skills
  # are global, and another gated repo may still be using them.
  if ($Skills -or $scope -eq "global") { Uninstall-Skills }
}

if ($Help) { Show-Usage; exit 0 }
if ($Uninstall) { Invoke-Uninstall } else { Invoke-Install }
