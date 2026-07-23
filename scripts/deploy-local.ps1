#requires -Version 5
<#
.SYNOPSIS
  Pack the language server and install it into the local Zed extension cache,
  for fast local iteration before publishing to npm.

.DESCRIPTION
  In production the Zed extension installs the language server from npm via the
  Rust API (npm_install_package). During local development the published npm
  version can lag behind your working tree, so this script `npm pack`s the
  current tree and installs that tarball into Zed's extension work directory —
  the same layout Zed produces — so a "restart language server" picks up your
  changes.

  After running this, restart the server in Zed:
    Command Palette -> "restart language server"
  (with a .ts / .vue / .tsx / .js / .jsx file focused).

.PARAMETER ExtensionId
  Zed extension id (the folder name under extensions\work). Defaults to i18n-lens-language-server.

.EXAMPLE
  ./scripts/deploy-local.ps1
#>
[CmdletBinding()]
param(
  [string]$ExtensionId = 'i18n-lens-language-server'
)

$ErrorActionPreference = 'Stop'

# Resolve the repo root from this script's location (scripts/ -> repo root) so
# the script works regardless of the caller's current directory.
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not (Test-Path 'package.json')) {
  throw "package.json not found in $repoRoot - run this from the repo root."
}

$pkgName = (node -p "require('./package.json').name").Trim()
$version = (node -p "require('./package.json').version").Trim()

$cacheDir = Join-Path $env:LOCALAPPDATA "Zed\extensions\work\$ExtensionId"
if (-not (Test-Path $cacheDir)) {
  throw @"
Zed cache dir not found: $cacheDir
Install the dev extension in Zed first (Command Palette -> 'install dev extension',
select this repo), then open a .ts/.vue file so the extension work dir is created.
"@
}

Write-Host "Packing $pkgName@$version..." -ForegroundColor Cyan
$tarball = (npm pack --silent | Select-Object -Last 1).Trim()
$tarballPath = Join-Path $repoRoot $tarball

Push-Location $cacheDir
try {
  Write-Host "Installing tarball into $cacheDir ..." -ForegroundColor Cyan
  npm install $tarballPath --no-save
  if ($LASTEXITCODE -ne 0) { throw 'npm install of the tarball failed.' }
}
finally {
  Pop-Location
  Remove-Item $tarballPath -ErrorAction SilentlyContinue
}

Write-Host "Deployed $pkgName@$version -> $cacheDir\node_modules\$pkgName" -ForegroundColor Green
Write-Host "Next: in Zed run Command Palette -> 'restart language server'." -ForegroundColor Yellow
