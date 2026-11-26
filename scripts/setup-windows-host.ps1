[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$MeshIP,

    [string]$HostName = $env:COMPUTERNAME,

    [string]$EnvFile = "",

    [switch]$InstallApollo,

    [switch]$SkipFirewall,

    [string]$EasyTierVersion = "v2.6.4",

    [string]$ApolloVersion = "v0.4.6"
)

$ErrorActionPreference = "Stop"

if (-not $EnvFile) {
    $EnvFile = Join-Path $PSScriptRoot "..\secrets\silkwarp.env"
}

$IsAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) {
    throw "Please run this script in an Administrator PowerShell session."
}

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
        $k = $trimmed.Substring(0, $idx).Trim()
        $v = $trimmed.Substring($idx + 1).Trim()
        $map[$k] = $v
    }
    return $map
}

$Cfg = Read-SilkWarpEnv $EnvFile
$SignalingHost = $Cfg["SILKWARP_SIGNALING_HOST"]
$RelayHost = $Cfg["SILKWARP_RELAY_HOST"]
$CoordPort = $Cfg["SILKWARP_EASYTIER_COORD_PORT"]
$RelayPort = $Cfg["SILKWARP_EASYTIER_RELAY_PORT"]
$MeshCidr = if ($Cfg["SILKWARP_MESH_CIDR"]) { $Cfg["SILKWARP_MESH_CIDR"] } else { "10.144.0.0/24" }
$NetworkName = $Cfg["SILKWARP_NETWORK_NAME"]
$NetworkSecret = $Cfg["SILKWARP_NETWORK_SECRET"]
$RustDeskPubKey = $Cfg["RUSTDESK_PUBLIC_KEY"]

if (-not $NetworkName -or -not $NetworkSecret) {
    throw "SILKWARP_NETWORK_NAME and SILKWARP_NETWORK_SECRET must be set in $EnvFile"
}

if ($MeshIP -notmatch '/\d+$') {
    $MeshIP = "$MeshIP/24"
}

$BaseDir = "C:\ProgramData\SilkWarp"
$EtDir = Join-Path $BaseDir "easytier"
$InstallerDir = Join-Path $BaseDir "installers"
$TempDir = Join-Path $env:TEMP ("silkwarp-et-" + [guid]::NewGuid().ToString("N"))

New-Item -ItemType Directory -Force -Path $EtDir, $InstallerDir, $TempDir | Out-Null

try {
    Write-Host "==> [1/4] Downloading EasyTier $EasyTierVersion for Windows" -ForegroundColor Cyan
    $EtZip = Join-Path $TempDir "easytier.zip"
    $EtUrl = "https://github.com/EasyTier/EasyTier/releases/download/$EasyTierVersion/easytier-windows-x86_64-$EasyTierVersion.zip"
    Invoke-WebRequest -Uri $EtUrl -OutFile $EtZip -UseBasicParsing

    $ExtractDir = Join-Path $TempDir "extracted"
    Expand-Archive -Path $EtZip -DestinationPath $ExtractDir -Force

    $TaskName = "SilkWarp-EasyTier"
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }
    Get-Process -Name "easytier-core" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

    $Files = Get-ChildItem -Path $ExtractDir -Recurse -File | Where-Object { $_.Extension -in ".exe", ".dll" }
    if (-not $Files) {
        throw "No EasyTier binaries found in $EtZip"
    }
    foreach ($f in $Files) {
        Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $EtDir $f.Name) -Force
    }
}
finally {
    Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "==> [2/4] Writing EasyTier host config ($HostName -> $MeshIP)" -ForegroundColor Cyan
$ConfigPath = Join-Path $EtDir "config.toml"
$ConfigText = @"
hostname = "$HostName"
ipv4 = "$MeshIP"
dhcp = false

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
[System.IO.File]::WriteAllText($ConfigPath, $ConfigText, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "==> [3/4] Registering SYSTEM startup task: $TaskName" -ForegroundColor Cyan
$Action = New-ScheduledTaskAction -Execute (Join-Path $EtDir "easytier-core.exe") -Argument "-c `"$ConfigPath`" --rpc-portal 127.0.0.1:15888 --rpc-portal-whitelist 127.0.0.1,127.0.0.0/8,::1/128" -WorkingDirectory $EtDir
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

if (-not $SkipFirewall) {
    Write-Host "==> [4/4] Configuring Windows Firewall rules (Apollo/Sunshine scoped to $MeshCidr)" -ForegroundColor Cyan
    foreach ($RuleName in @("SilkWarp-Apollo-TCP", "SilkWarp-Apollo-UDP")) {
        Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    }
    New-NetFirewallRule -DisplayName "SilkWarp-Apollo-TCP" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 47984,47989,47990,48010 -RemoteAddress $MeshCidr | Out-Null
    New-NetFirewallRule -DisplayName "SilkWarp-Apollo-UDP" -Direction Inbound -Action Allow -Protocol UDP -LocalPort 47998-48000,48002,48010 -RemoteAddress $MeshCidr | Out-Null
} else {
    Write-Host "==> [4/4] Skipping firewall rules (--SkipFirewall)" -ForegroundColor Yellow
}

if ($InstallApollo) {
    $ApolloVerClean = $ApolloVersion -replace '^v', ''
    $ApolloUrl = "https://github.com/ClassicOldSong/Apollo/releases/download/$ApolloVersion/Apollo-$ApolloVerClean.exe"
    $ApolloInstaller = Join-Path $InstallerDir "Apollo-$ApolloVerClean.exe"
    Write-Host "==> Downloading Apollo $ApolloVersion to $ApolloInstaller" -ForegroundColor Cyan
    Invoke-WebRequest -Uri $ApolloUrl -OutFile $ApolloInstaller -UseBasicParsing
    Write-Host "    Run installer: `"$ApolloInstaller`"" -ForegroundColor Green
}

Write-Host "`n[OK] Windows GPU host EasyTier configured!" -ForegroundColor Green
Write-Host "  - Mesh IP        : $MeshIP"
Write-Host "  - EasyTier CLI   : & `"$EtDir\easytier-cli.exe`" -p 127.0.0.1:15888 peer"
Write-Host "  - RustDesk ID    : $SignalingHost"
if ($RustDeskPubKey) {
    Write-Host "  - RustDesk Key   : $RustDeskPubKey"
} else {
    Write-Host "  - RustDesk Key   : <Check secrets/silkwarp.env after hbbs deployment>"
}
