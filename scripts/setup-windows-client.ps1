[CmdletBinding()]
param(
    [string]$ClientName = $env:COMPUTERNAME,

    [string]$MeshIP = "",

    [string]$EnvFile = "",

    [string]$OutDir = "",

    [switch]$DownloadApps,

    [string]$EasyTierVersion = "v2.6.4",

    [string]$MoonlightVersion = "v6.2.0"
)

$ErrorActionPreference = "Stop"

if (-not $EnvFile) { $EnvFile = Join-Path $PSScriptRoot "..\secrets\silkwarp.env" }
if (-not $OutDir) { $OutDir = Join-Path $env:USERPROFILE "SilkWarp" }

if (-not (Test-Path -LiteralPath $EnvFile)) {
    throw "Env file not found: $EnvFile"
}

function Read-SilkWarpEnv([string]$Path) {
    $map = @{}
    foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
        $idx = $trimmed.IndexOf("=")
        if ($idx -lt 1) { continue }
        $map[$trimmed.Substring(0, $idx).Trim()] = $trimmed.Substring($idx + 1).Trim()
    }
    return $map
}

$Cfg = Read-SilkWarpEnv $EnvFile
$SignalingHost = $Cfg["SILKWARP_SIGNALING_HOST"]
$RelayHost = $Cfg["SILKWARP_RELAY_HOST"]
$CoordPort = $Cfg["SILKWARP_EASYTIER_COORD_PORT"]
$RelayPort = $Cfg["SILKWARP_EASYTIER_RELAY_PORT"]
$RelayMeshIP = if ($Cfg["SILKWARP_RELAY_MESH_IP"]) { $Cfg["SILKWARP_RELAY_MESH_IP"] } else { "10.144.0.1" }
$WolPort = if ($Cfg["SILKWARP_WOL_PORT"]) { $Cfg["SILKWARP_WOL_PORT"] } else { "9580" }
$NetworkName = $Cfg["SILKWARP_NETWORK_NAME"]
$NetworkSecret = $Cfg["SILKWARP_NETWORK_SECRET"]
$RustDeskPubKey = $Cfg["RUSTDESK_PUBLIC_KEY"]

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$IpBlock = if ($MeshIP) {
    if ($MeshIP -notmatch '/\d+$') { $MeshIP = "$MeshIP/24" }
    "ipv4 = `"$MeshIP`"`ndhcp = false"
} else {
    "dhcp = true"
}

$ClientToml = @"
hostname = "$ClientName"
$IpBlock

listeners = [
    "tcp://0.0.0.0:0",
    "udp://0.0.0.0:0",
    "tcp://[::]:0",
    "udp://[::]:0",
]

rpc_portal = "127.0.0.1:15888"

[[peer]]
uri = "udp://${RelayHost}:${RelayPort}"

[[peer]]
uri = "tcp://${RelayHost}:${RelayPort}"

[[peer]]
uri = "udp://${SignalingHost}:${CoordPort}"

[[peer]]
uri = "tcp://${SignalingHost}:${CoordPort}"

[network_identity]
network_name = "$NetworkName"
network_secret = "$NetworkSecret"

[flags]
latency_first = true
multi_thread = true
enable_ipv6 = true
enable_encryption = true
"@

$TomlPath = Join-Path $OutDir "easytier-client.toml"
[System.IO.File]::WriteAllText($TomlPath, $ClientToml, (New-Object System.Text.UTF8Encoding($false)))

if ($DownloadApps) {
    $AppDir = Join-Path $OutDir "installers"
    New-Item -ItemType Directory -Force -Path $AppDir | Out-Null

    $EtVerClean = $EasyTierVersion -replace '^v', ''
    $MlVerClean = $MoonlightVersion -replace '^v', ''
    $EtGuiUrl = "https://github.com/EasyTier/EasyTier/releases/download/$EasyTierVersion/easytier-gui_${EtVerClean}_x64-setup.exe"
    $MlUrl = "https://github.com/moonlight-stream/moonlight-qt/releases/download/$MoonlightVersion/MoonlightSetup-$MlVerClean.exe"

    Write-Host "==> Downloading EasyTier GUI $EasyTierVersion" -ForegroundColor Cyan
    Invoke-WebRequest -Uri $EtGuiUrl -OutFile (Join-Path $AppDir "easytier-gui_${EtVerClean}_x64-setup.exe") -UseBasicParsing
    Write-Host "==> Downloading Moonlight $MoonlightVersion" -ForegroundColor Cyan
    Invoke-WebRequest -Uri $MlUrl -OutFile (Join-Path $AppDir "MoonlightSetup-$MlVerClean.exe") -UseBasicParsing
}

Write-Host "`n[OK] Client EasyTier config generated: $TomlPath" -ForegroundColor Green
Write-Host "  - RustDesk ID Server : $SignalingHost"
if ($RustDeskPubKey) {
    Write-Host "  - RustDesk Key       : $RustDeskPubKey"
}
Write-Host "  - WOL Console        : http://${RelayMeshIP}:${WolPort}/"
