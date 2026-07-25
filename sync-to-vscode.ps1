# Sync this source checkout into the installed VS Code / Cursor extension folder.
# Each app loads its own extensions dir - not this repo - so after editing source
# you must sync, then: Command Palette -> "Developer: Reload Window".
#
# Usage (from anywhere):
#   .\sync-to-vscode.ps1                    # VS Code + Cursor (default)
#   .\sync-to-vscode.ps1 -Target vscode     # VS Code only
#   .\sync-to-vscode.ps1 -Target cursor     # Cursor only
#   .\sync-to-vscode.ps1 -WhatIf            # preview only
#   .\sync-to-vscode.ps1 -Destination X     # custom install path (ignores -Target)
#
# Developing via F5 (Extension Development Host) loads this source directly
# and does not need this script.

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateSet('vscode', 'cursor', 'both')]
    [string]$Target = 'both',

    [string]$Destination
)

$ErrorActionPreference = 'Stop'

$Src = $PSScriptRoot
$ExtensionId = 'local.ygo-duel'
$RelativeLocation = 'ygo-duel'

if (-not (Test-Path -LiteralPath (Join-Path $Src 'extension.js'))) {
    Write-Error "Source looks wrong - extension.js not found under: $Src"
}

function Get-PackageVersion {
    param([string]$PackageJsonPath)
    try {
        $pkg = Get-Content -LiteralPath $PackageJsonPath -Raw | ConvertFrom-Json
        if ($pkg.version) { return [string]$pkg.version }
    } catch { }
    return '0.0.0'
}

function Ensure-ExtensionRegistered {
    param(
        [string]$ExtensionsRoot,
        [string]$InstallDir,
        [string]$Version
    )

    $registryPath = Join-Path $ExtensionsRoot 'extensions.json'
    $id = $ExtensionId

    if (-not (Test-Path -LiteralPath $registryPath)) {
        Write-Warning "No extensions.json at $registryPath - skipping register. Install once via VSIX, or create the file by installing any marketplace extension."
        return
    }

    try {
        $raw = Get-Content -LiteralPath $registryPath -Raw
        $list = @(ConvertFrom-Json -InputObject $raw)
    } catch {
        Write-Warning "Could not parse $registryPath - skipping registry update."
        return
    }

    if ($list | Where-Object { $_.identifier.id -eq $id }) {
        Write-Host "  OK  already registered ($id)"
        return
    }

    # Match the shape VS Code / Cursor write for a local (non-gallery) install.
    # Append-only: never rewrite existing entries (avoids mangling gallery metadata).
    $fsPath = [System.IO.Path]::GetFullPath($InstallDir)
    $slashPath = $fsPath -replace '\\', '/'
    $unixPath = '/' + $slashPath
    $external = 'file:///' + ($slashPath -replace ':', '%3A')

    $entry = [ordered]@{
        identifier       = @{ id = $id }
        version          = $Version
        location         = [ordered]@{
            '$mid'   = 1
            fsPath   = $fsPath
            _sep     = 1
            external = $external
            path     = $unixPath
            scheme   = 'file'
        }
        relativeLocation = $RelativeLocation
    }
    $entryJson = (ConvertTo-Json -InputObject $entry -Depth 10 -Compress)

    if ($PSCmdlet.ShouldProcess($registryPath, "Register $id")) {
        $trimmed = $raw.TrimEnd()
        if (-not $trimmed.EndsWith(']')) {
            Write-Warning "Unexpected extensions.json format - skipping register."
            return
        }
        if ($trimmed -eq '[]') {
            $newRaw = '[' + $entryJson + ']'
        } else {
            $newRaw = $trimmed.Substring(0, $trimmed.Length - 1).TrimEnd() + ',' + $entryJson + ']'
        }
        try {
            $null = ConvertFrom-Json -InputObject $newRaw
        } catch {
            Write-Warning "Built invalid JSON for registry append - skipping. Install via VSIX instead."
            return
        }
        $utf8NoBom = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($registryPath, $newRaw, $utf8NoBom)
        Write-Host "  OK  registered $id in extensions.json"
    }
}

function Sync-ToDestination {
    param(
        [string]$Dst,
        [string]$Label
    )

    Write-Host ""
    Write-Host "=== $Label ==="
    Write-Host "-> $Dst"

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

    $version = Get-PackageVersion -PackageJsonPath (Join-Path $Src 'package.json')
    $extensionsRoot = Split-Path -Parent $Dst
    Ensure-ExtensionRegistered -ExtensionsRoot $extensionsRoot -InstallDir $Dst -Version $version

    Write-Host "Synced: $Src"
    Write-Host "    ->  $Dst"
}

# Resolve destination list
$destinations = @()
if ($PSBoundParameters.ContainsKey('Destination') -and $Destination) {
    $destinations += @{ Path = $Destination; Label = 'Custom' }
} else {
    if ($Target -eq 'vscode' -or $Target -eq 'both') {
        $destinations += @{
            Path  = (Join-Path $env:USERPROFILE '.vscode\extensions\ygo-duel')
            Label = 'VS Code'
        }
    }
    if ($Target -eq 'cursor' -or $Target -eq 'both') {
        $destinations += @{
            Path  = (Join-Path $env:USERPROFILE '.cursor\extensions\ygo-duel')
            Label = 'Cursor'
        }
    }
}

foreach ($dest in $destinations) {
    Sync-ToDestination -Dst $dest.Path -Label $dest.Label
}

Write-Host ""
Write-Host 'Next: Command Palette -> "Developer: Reload Window"'
Write-Host '(Or develop with F5 instead - that loads this source directly.)'
