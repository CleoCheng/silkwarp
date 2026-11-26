[CmdletBinding()]
param(
    [string]$EnvFile = "",
    [string]$ConfigFile = "",
    [int]$TimeoutMs = 2500
)

$ErrorActionPreference = "Stop"
if (-not $EnvFile) {
    $EnvFile = Join-Path $PSScriptRoot "..\secrets\silkwarp.env"
}
if (-not $ConfigFile) {
    $ConfigFile = Join-Path $PSScriptRoot "..\silkwarp.config.json"
}

$SignalingHost = ""
$RelayHost = ""
$CoordPort = 11010
$RelayPort = 11011
$HbbsPort = 21116
$HbbsNatPort = 21115
$HbbrPort = 21117

if (Test-Path -LiteralPath $ConfigFile) {
    $jsonCfg = Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($jsonCfg.signalingHost) { $SignalingHost = [string]$jsonCfg.signalingHost }
    if ($jsonCfg.relayHost) { $RelayHost = [string]$jsonCfg.relayHost }
    if ($jsonCfg.easytierCoordPort) { $CoordPort = [int]$jsonCfg.easytierCoordPort }
    if ($jsonCfg.easytierRelayPort) { $RelayPort = [int]$jsonCfg.easytierRelayPort }
    if ($jsonCfg.rustdeskHbbsPort) { $HbbsPort = [int]$jsonCfg.rustdeskHbbsPort }
    if ($jsonCfg.rustdeskHbbrPort) { $HbbrPort = [int]$jsonCfg.rustdeskHbbrPort }
}

if (Test-Path -LiteralPath $EnvFile) {
    foreach ($line in Get-Content -LiteralPath $EnvFile -Encoding UTF8) {
        $t = $line.Trim()
        if (-not $t -or $t.StartsWith("#")) { continue }
        $i = $t.IndexOf("=")
        if ($i -lt 1) { continue }
        $k = $t.Substring(0, $i).Trim()
        $v = $t.Substring($i + 1).Trim()
        switch ($k) {
            "SILKWARP_SIGNALING_HOST" { if ($v) { $SignalingHost = $v } }
            "SILKWARP_RELAY_HOST" { if ($v) { $RelayHost = $v } }
            "SILKWARP_EASYTIER_COORD_PORT" { if ($v) { $CoordPort = [int]$v } }
            "SILKWARP_EASYTIER_RELAY_PORT" { if ($v) { $RelayPort = [int]$v } }
            "SILKWARP_RUSTDESK_HBBS_PORT" { if ($v) { $HbbsPort = [int]$v } }
            "SILKWARP_RUSTDESK_HBBR_PORT" { if ($v) { $HbbrPort = [int]$v } }
        }
    }
}

if (-not $SignalingHost -or -not $RelayHost) {
    throw "Missing signalingHost or relayHost. Copy silkwarp.config.example.json to silkwarp.config.json (or configure secrets/silkwarp.env) first."
}

function Test-TcpPort([string]$HostName, [int]$Port, [int]$WaitMs) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect($HostName, $Port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne($WaitMs, $false)
        if (-not $ok) {
            return "TIMEOUT"
        }
        $client.EndConnect($iar)
        return "OPEN"
    }
    catch {
        return "CLOSED"
    }
    finally {
        $client.Close()
    }
}

Write-Host "=== SilkWarp Connectivity & Mesh Check ===" -ForegroundColor Cyan
Write-Host "`n[1] DNS Resolution ($RelayHost):"
try {
    $Records = Resolve-DnsName -Name $RelayHost -ErrorAction Stop | Where-Object { $_.Type -in "A", "AAAA" }
    foreach ($rec in $Records) {
        Write-Host ("  {0,-6} {1} (TTL {2}s)" -f $rec.Type, $rec.IPAddress, $rec.TTL)
    }
}
catch {
    Write-Host "  DNS resolution error: $($_.Exception.Message)" -ForegroundColor Red
}

$Targets = @(
    @{ Name = "Signaling EasyTier Coord"; Host = $SignalingHost; Port = $CoordPort },
    @{ Name = "Signaling RustDesk NAT";   Host = $SignalingHost; Port = $HbbsNatPort },
    @{ Name = "Signaling RustDesk ID";    Host = $SignalingHost; Port = $HbbsPort },
    @{ Name = "Relay EasyTier Hub";       Host = $RelayHost;     Port = $RelayPort },
    @{ Name = "Relay RustDesk Relay";     Host = $RelayHost;     Port = $HbbrPort }
)

Write-Host "`n[2] TCP Reachability:"
foreach ($t in $Targets) {
    $state = Test-TcpPort -HostName $t.Host -Port $t.Port -WaitMs $TimeoutMs
    $color = if ($state -eq "OPEN") { "Green" } else { "Yellow" }
    Write-Host ("  {0,-24} {1}:{2,-6} -> {3}" -f $t.Name, $t.Host, $t.Port, $state) -ForegroundColor $color
}

Write-Host "`n[3] Local EasyTier Mesh Status:"
$CliCandidates = @(
    "C:\ProgramData\SilkWarp\easytier\easytier-cli.exe",
    (Get-Command "easytier-cli" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue)
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

if ($CliCandidates) {
    $Cli = $CliCandidates[0]
    Write-Host "  Using $Cli"
    & $Cli -p 127.0.0.1:15888 peer
    & $Cli -p 127.0.0.1:15888 route
} else {
    Write-Host "  easytier-cli not installed locally (skipped)."
}
