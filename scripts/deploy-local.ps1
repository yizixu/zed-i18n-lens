#requires -Version 5
<#
.SYNOPSIS
  Build the i18n-lens language server bundle and deploy it into the local Zed
  extension cache, for fast local iteration without cutting a GitHub release.

.DESCRIPTION
  The Zed extension (Rust/WASM shell) downloads the bundled Node language server
  (i18n-lens-server-<version>.cjs) from a GitHub release into its work directory
  on first use. For local development we rebuild that bundle with esbuild and
  overwrite the cached copy in place, so changes take effect on the next
  "restart language server" in Zed.

  After running this, restart the server in Zed:
    Command Palette -> "restart language server"
  (with a .ts / .vue / .tsx / .js / .jsx file focused).

.PARAMETER ExtensionId
  Zed extension id (the folder name under extensions\work). Defaults to i18n-lens.

.EXAMPLE
  ./scripts/deploy-local.ps1
#>
[CmdletBinding()]
param(
  [string]$ExtensionId = 'i18n-lens'
)

$ErrorActionPreference = 'Stop'

# Resolve the repo root from this script's location (scripts/ -> repo root) so
# the script works regardless of the caller's current directory.
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not (Test-Path 'package.json')) {
  throw "package.json not found in $repoRoot - run this from the zed-i18n-lens repo."
}

# The cached file name embeds the version (see SERVER_VERSION in src/lib.rs),
# which is single-sourced from package.json / Cargo.toml / extension.toml.
$version = (node -p "require('./package.json').version").Trim()
if (-not $version) { throw 'Failed to read version from package.json.' }

Write-Host "Building language server bundle (v$version)..." -ForegroundColor Cyan
npm run build:server
if ($LASTEXITCODE -ne 0) { throw 'npm run build:server failed.' }

$built = Join-Path $repoRoot 'server\dist\i18n-lens-server.cjs'
if (-not (Test-Path $built)) { throw "Build output missing: $built" }

$cacheDir = Join-Path $env:LOCALAPPDATA "Zed\extensions\work\$ExtensionId"
if (-not (Test-Path $cacheDir)) {
  throw @"
Zed cache dir not found: $cacheDir
Install the dev extension in Zed first (Command Palette -> 'install dev extension',
select this repo), then open a .ts/.vue file so the server is fetched once.
"@
}

$dest = Join-Path $cacheDir "i18n-lens-server-$version.cjs"
Copy-Item $built $dest -Force

$sizeKb = [math]::Round((Get-Item $dest).Length / 1KB, 1)
Write-Host "Deployed -> $dest ($sizeKb KB)" -ForegroundColor Green
Write-Host "Next: in Zed run Command Palette -> 'restart language server'." -ForegroundColor Yellow
