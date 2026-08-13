# Build a .vsix package for the ygo-duel extension.
#
# Usage (from anywhere):
#   .\build-vsix.ps1
#   .\build-vsix.ps1 -WhatIf   # preview only

[CmdletBinding(SupportsShouldProcess = $true)]
param()

$ErrorActionPreference = 'Stop'

$Src = $PSScriptRoot

if (-not (Test-Path -LiteralPath (Join-Path $Src 'extension.js'))) {
    Write-Error "Source looks wrong - extension.js not found under: $Src"
}

# Node: PATH first (normal install), then Claude Code bundle fallback.
$NodeExe = $null
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($NodeCmd) {
    $NodeExe = $NodeCmd.Source
} else {
    $FallbackNode = Join-Path $env:USERPROFILE '.chubb-claude\nodejs\node.exe'
    if (Test-Path -LiteralPath $FallbackNode) { $NodeExe = $FallbackNode }
}
if (-not $NodeExe) {
    Write-Error "node.exe not found. Install Node.js (https://nodejs.org) or ensure it is on PATH."
}

$NodeDir = Split-Path -Parent $NodeExe

# vsce: cached npx install if present, else npx will fetch @vscode/vsce on the fly.
$NpxCache = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
$VsceEntry = Get-ChildItem -LiteralPath $NpxCache -Recurse -Filter 'vsce' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.DirectoryName -notlike '*\.bin*' } |
    Select-Object -First 1

$NpxExe = (Get-Command npx -ErrorAction SilentlyContinue).Source
if (-not $NpxExe -and (Test-Path -LiteralPath (Join-Path $NodeDir 'npx.cmd'))) {
    $NpxExe = Join-Path $NodeDir 'npx.cmd'
}

Write-Host "Node : $NodeExe"
if ($VsceEntry) {
    Write-Host "vsce : $($VsceEntry.FullName)"
} elseif ($NpxExe) {
    Write-Host "vsce : npx @vscode/vsce (on demand)"
} else {
    Write-Error "npx not found next to node. Reinstall Node.js from https://nodejs.org"
}
Write-Host ""

if ($PSCmdlet.ShouldProcess($Src, 'Run vsce package')) {
    $env:PATH = "$NodeDir;$env:PATH"
    Push-Location $Src
    try {
        if ($VsceEntry) {
            & $NodeExe $VsceEntry.FullName package
        } else {
            & $NpxExe --yes @vscode/vsce package
        }
        if ($LASTEXITCODE -ne 0) { Write-Error "vsce package failed (exit $LASTEXITCODE)." }
    } finally {
        Pop-Location
    }

    $Vsix = Get-ChildItem -LiteralPath $Src -Filter "*.vsix" | Sort-Object LastWriteTime | Select-Object -Last 1
    Write-Host ""
    Write-Host "Built: $($Vsix.Name)"
    Write-Host ""
    Write-Host 'To install: Extensions sidebar -> "..." -> "Install from VSIX..."'
}
