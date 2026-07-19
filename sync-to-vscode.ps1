# Sync this source checkout into the installed VS Code extension folder.
# VS Code loads ~/.vscode/extensions/ygo-duel/ - not this repo - so after
# editing source you must sync, then: Command Palette -> "Developer: Reload Window".
#
# Usage (from anywhere):
#   .\sync-to-vscode.ps1
#   .\sync-to-vscode.ps1 -WhatIf          # preview only
#   .\sync-to-vscode.ps1 -Destination X   # custom install path
#
# Developing via F5 (Extension Development Host) loads this source directly
# and does not need this script.

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Destination = (Join-Path $env:USERPROFILE '.vscode\extensions\ygo-duel')
)

$ErrorActionPreference = 'Stop'

$Src = $PSScriptRoot
$Dst = $Destination

if (-not (Test-Path -LiteralPath (Join-Path $Src 'extension.js'))) {
    Write-Error "Source looks wrong - extension.js not found under: $Src"
}

if (-not (Test-Path -LiteralPath $Dst)) {
    Write-Host "Creating install folder: $Dst"
    if ($PSCmdlet.ShouldProcess($Dst, 'Create directory')) {
        New-Item -ItemType Directory -Path $Dst -Force | Out-Null
    }
}

$dirs = @(
    (Join-Path $Dst 'games'),
    (Join-Path $Dst 'media')
)
foreach ($d in $dirs) {
    if (-not (Test-Path -LiteralPath $d)) {
        if ($PSCmdlet.ShouldProcess($d, 'Create directory')) {
            New-Item -ItemType Directory -Path $d -Force | Out-Null
        }
    }
}

# Same file set as the README "Option A - manual sync" list.
$copies = @(
    @{ From = 'extension.js';      To = 'extension.js' }
    @{ From = 'github.js';         To = 'github.js' }
    @{ From = 'http.js';           To = 'http.js' }
    @{ From = 'package.json';      To = 'package.json' }
    @{ From = 'media\duel.html';   To = 'media\duel.html' }
    @{ From = 'media\binder.html'; To = 'media\binder.html' }
)

foreach ($c in $copies) {
    $from = Join-Path $Src $c.From
    $to = Join-Path $Dst $c.To
    if (-not (Test-Path -LiteralPath $from)) {
        Write-Warning "Missing source file (skipped): $($c.From)"
        continue
    }
    if ($PSCmdlet.ShouldProcess($to, "Copy from $($c.From)")) {
        Copy-Item -LiteralPath $from -Destination $to -Force
        Write-Host "  OK  $($c.From)"
    }
}

# games/*.js
$gameFiles = Get-ChildItem -LiteralPath (Join-Path $Src 'games') -Filter '*.js' -File -ErrorAction SilentlyContinue
foreach ($f in $gameFiles) {
    $to = Join-Path $Dst "games\$($f.Name)"
    if ($PSCmdlet.ShouldProcess($to, "Copy from games\$($f.Name)")) {
        Copy-Item -LiteralPath $f.FullName -Destination $to -Force
        Write-Host "  OK  games\$($f.Name)"
    }
}

# optional pack art (pack-yugioh.jpg, pack-pokemon.jpg, ...)
$packFiles = Get-ChildItem -LiteralPath (Join-Path $Src 'media') -Filter 'pack-*' -File -ErrorAction SilentlyContinue
foreach ($f in $packFiles) {
    $to = Join-Path $Dst "media\$($f.Name)"
    if ($PSCmdlet.ShouldProcess($to, "Copy from media\$($f.Name)")) {
        Copy-Item -LiteralPath $f.FullName -Destination $to -Force
        Write-Host "  OK  media\$($f.Name)"
    }
}

Write-Host ""
Write-Host "Synced: $Src"
Write-Host "    ->  $Dst"
Write-Host ""
Write-Host 'Next: VS Code Command Palette -> "Developer: Reload Window"'
Write-Host '(Or develop with F5 instead - that loads this source directly.)'
