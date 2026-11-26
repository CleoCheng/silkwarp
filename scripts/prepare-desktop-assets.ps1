[CmdletBinding()]
param(
    [string]$EasyTierVersion = "v2.6.4",
    [string]$MoonlightVersion = "v6.2.0",
    [string]$ApolloVersion = "v0.4.6"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$DesktopDir = Join-Path $Root "apps\desktop"
$CacheDir = Join-Path $Root "secrets\cache"
$ResDir = Join-Path $DesktopDir "resources"
$EtResDir = Join-Path $ResDir "easytier"
$MlResDir = Join-Path $ResDir "moonlight"
$InstResDir = Join-Path $ResDir "installers"
$BuildDir = Join-Path $DesktopDir "build"

New-Item -ItemType Directory -Force -Path $CacheDir, $EtResDir, $MlResDir, $InstResDir, $BuildDir | Out-Null

$EtZip = Join-Path $CacheDir "easytier-windows-x86_64-$EasyTierVersion.zip"
$EtUrl = "https://github.com/EasyTier/EasyTier/releases/download/$EasyTierVersion/easytier-windows-x86_64-$EasyTierVersion.zip"
if (-not (Test-Path -LiteralPath $EtZip)) {
    Write-Host "==> Downloading EasyTier $EasyTierVersion Windows binaries" -ForegroundColor Cyan
    Invoke-WebRequest -Uri $EtUrl -OutFile $EtZip -TimeoutSec 90
}

$MlVerClean = $MoonlightVersion -replace '^v', ''
$MlZip = Join-Path $CacheDir "MoonlightPortable-x64-$MlVerClean.zip"
$MlUrl = "https://github.com/moonlight-stream/moonlight-qt/releases/download/$MoonlightVersion/MoonlightPortable-x64-$MlVerClean.zip"
if (-not (Test-Path -LiteralPath $MlZip)) {
    Write-Host "==> Downloading Moonlight Portable $MoonlightVersion" -ForegroundColor Cyan
    Invoke-WebRequest -Uri $MlUrl -OutFile $MlZip -TimeoutSec 90
}

$ApolloVerClean = $ApolloVersion -replace '^v', ''
$ApolloExe = Join-Path $CacheDir "Apollo-$ApolloVerClean.exe"
$ApolloUrl = "https://github.com/ClassicOldSong/Apollo/releases/download/$ApolloVersion/Apollo-$ApolloVerClean.exe"
if (-not (Test-Path -LiteralPath $ApolloExe)) {
    Write-Host "==> Downloading Apollo $ApolloVersion offline installer" -ForegroundColor Cyan
    Invoke-WebRequest -Uri $ApolloUrl -OutFile $ApolloExe -TimeoutSec 120
}

$TmpDir = Join-Path $env:TEMP ("silkwarp-assets-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null

try {
    Write-Host "==> Staging EasyTier binaries into apps/desktop/resources/easytier" -ForegroundColor Cyan
    $EtTmp = Join-Path $TmpDir "et"
    Expand-Archive -Path $EtZip -DestinationPath $EtTmp -Force
    Get-ChildItem -Path $EtTmp -Recurse -File | Where-Object { $_.Extension -in ".exe", ".dll" } | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $EtResDir $_.Name) -Force
    }

    Write-Host "==> Staging Moonlight Portable into apps/desktop/resources/moonlight" -ForegroundColor Cyan
    Expand-Archive -Path $MlZip -DestinationPath $MlResDir -Force

    Write-Host "==> Staging Apollo offline installer into apps/desktop/resources/installers" -ForegroundColor Cyan
    Copy-Item -LiteralPath $ApolloExe -Destination (Join-Path $InstResDir "Apollo-$ApolloVerClean.exe") -Force
}
finally {
    Remove-Item -Path $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "==> Generating application icon (PNG + multi-size ICO)" -ForegroundColor Cyan
$GenIcon = Join-Path $DesktopDir "scripts\gen_icon.py"
if (Test-Path -LiteralPath $GenIcon) {
    & python $GenIcon
    if ($LASTEXITCODE -ne 0) { throw "Failed generating desktop icons" }
}

Write-Host "[OK] Desktop bundled resources staged." -ForegroundColor Green
