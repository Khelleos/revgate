<#
  revgate installer (Windows / PowerShell) — build revgate and wire it into
  Copilot's agentStop hook.

    .\install.ps1                    # interactive: asks how to enable revgate
    .\install.ps1 -Global           # gate every repo you work in
    .\install.ps1 -Repo <path>      # gate a single repository
    .\install.ps1 -Uninstall        # remove the global hook
    .\install.ps1 -Uninstall -Repo <path>
#>
[CmdletBinding()]
param(
  [switch]$Global,
  [string]$Repo,
  [int]$Timeout = 3600,
  [switch]$Uninstall,
  [switch]$Help
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Entry = Join-Path $ScriptDir "dist\index.js"
$HookName = "revgate.json"

function Show-Usage {
  Write-Host @"
revgate installer

Usage:
  .\install.ps1 [-Global | -Repo <path>] [-Timeout <sec>]
  .\install.ps1 -Uninstall [-Repo <path>]
  .\install.ps1 -Help

Options:
  -Global          Gate every repository you work in (`$env:USERPROFILE\.copilot\hooks\$HookName).
  -Repo <path>     Gate one repository (<path>\.github\hooks\$HookName).
  -Timeout <sec>   Seconds revgate may wait for your review (default 3600).
  -Uninstall       Remove the revgate hook (global, or -Repo <path>).
  -Help            Show this help.

With no scope switch, the installer asks interactively.
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
  Write-Host "Installing dependencies…"
  Push-Location $ScriptDir
  try {
    & npm install --silent
    Write-Host "Building…"
    & npm run build --silent
  } finally {
    Pop-Location
  }
  if (-not (Test-Path $Entry)) {
    Write-Error "build did not produce $Entry"
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
    "agentStop": [
      {
        "type": "command",
        "comment": "revgate: open a GitHub-style review of the turn's changes and feed your review back to Copilot. Raise timeoutSec to however long you might spend reviewing.",
        "bash": "node \"$entryFwd\"",
        "powershell": "node \"$entryFwd\"",
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

function Invoke-Install {
  Assert-Node
  Invoke-Build

  $scope = if ($Global) { "global" } elseif ($Repo) { "repo" } else { "" }
  if (-not $scope) {
    Write-Host ""
    Write-Host "How should revgate be enabled?"
    Write-Host "  1) Globally - gate every repository you work in   (recommended)"
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
  Write-Host "OK  revgate installed."
  Write-Host "  Hook:  $target"
  Write-Host "  Runs:  node `"$entryFwd`""
  Write-Host ""
  Write-Host "Try it now (opens the review UI in your browser):"
  Write-Host "  node `"$entryFwd`" --demo"
  Write-Host ""
  Write-Host "From now on, when your Copilot agent finishes a turn with changes,"
  Write-Host "your browser opens a review. Approve -> the agent stops. Request changes"
  Write-Host "or leave comments -> the agent gets your feedback as its next prompt."
  Write-Host ""
  Write-Host "Uninstall:  .\install.ps1 -Uninstall"
}

function Invoke-Uninstall {
  $scope = if ($Repo) { "repo" } else { "global" }
  if ($scope -eq "repo") { Assert-Repo }
  $target = Get-HookTarget $scope
  if (Test-Path $target) {
    Remove-Item -Path $target -Force
    Write-Host "OK  removed $target"
  } else {
    Write-Host "no revgate hook found at $target"
  }
}

if ($Help) { Show-Usage; exit 0 }
if ($Uninstall) { Invoke-Uninstall } else { Invoke-Install }
