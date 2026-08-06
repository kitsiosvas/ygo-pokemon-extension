# Build a .vsix package for the ygo-duel extension.
# Uses the Node.js bundled with Claude Code and the vsce CLI cached by npx.
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

# Locate the Node.js bundled with Claude Code.
$NodeExe = Join-Path $env:USERPROFILE '.chubb-claude\nodejs\node.exe'
if (-not (Test-Path -LiteralPath $NodeExe)) {
    Write-Error "node.exe not found at: $NodeExe`nInstall Node.js or adjust the path in this script."
}

# Locate vsce from the npx cache (populated the first time 'npx vsce' was run).
$NpxCache = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
$VsceEntry = Get-ChildItem -LiteralPath $NpxCache -Recurse -Filter 'vsce' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.DirectoryName -notlike '*\.bin*' } |
    Select-Object -First 1

if (-not $VsceEntry) {
    Write-Error "vsce not found in npm cache ($NpxCache).`nRun 'npx vsce package' once in a terminal with Node on PATH to populate the cache."
}

$NpmDir = Join-Path $env:USERPROFILE '.chubb-claude\nodejs'

Write-Host "Node : $NodeExe"
Write-Host "vsce : $($VsceEntry.FullName)"
Write-Host ""

if ($PSCmdlet.ShouldProcess($Src, 'Run vsce package')) {
    $env:PATH = "$NpmDir;$env:PATH"
    Push-Location $Src
    try {
        & $NodeExe $VsceEntry.FullName package
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
