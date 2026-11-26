[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetHost,

    [int]$Port = 22,

    [string]$User = "root",

    [int]$EnableSshPort = 0,

    [string]$EnvFile = "",

    [string]$KeyDir = ""
)

$ErrorActionPreference = "Stop"

if (-not $EnvFile) { $EnvFile = Join-Path $PSScriptRoot "..\secrets\silkwarp.env" }
if (-not $KeyDir) { $KeyDir = Join-Path $PSScriptRoot "..\secrets\rustdesk" }

$DeployScript = Join-Path $PSScriptRoot "deploy-relay-r720.sh"
$WolScript = Join-Path $PSScriptRoot "..\services\wol-helper\silkwarp_wol.py"
$PrivKey = Join-Path $KeyDir "id_ed25519"
$PubKey = Join-Path $KeyDir "id_ed25519.pub"

foreach ($Required in @($EnvFile, $DeployScript, $WolScript, $PrivKey, $PubKey)) {
    if (-not (Test-Path -LiteralPath $Required)) {
        throw "Required file missing: $Required"
    }
}

$Remote = "$User@$TargetHost"
Write-Host "==> Preparing remote directories on ${Remote}:$Port" -ForegroundColor Cyan
& ssh -p $Port $Remote "mkdir -p /opt/silkwarp/rustdesk /opt/silkwarp/wol /opt/silkwarp/downloads"
if ($LASTEXITCODE -ne 0) { throw "SSH directory preparation failed." }

$CacheDir = Join-Path $PSScriptRoot "..\secrets\cache"
if (Test-Path -LiteralPath $CacheDir) {
    $CachedZips = Get-ChildItem -LiteralPath $CacheDir -Filter "*.zip" -File
    foreach ($z in $CachedZips) {
        Write-Host "==> Pre-staging cached archive $($z.Name)" -ForegroundColor Cyan
        & scp -P $Port $z.FullName "${Remote}:/opt/silkwarp/downloads/$($z.Name)"
        if ($LASTEXITCODE -ne 0) { throw "Failed uploading cached archive $($z.Name)" }
    }
}

Write-Host "==> Uploading silkwarp.env, RustDesk keys, WOL service, and deploy script" -ForegroundColor Cyan
& scp -P $Port $EnvFile "${Remote}:/opt/silkwarp/silkwarp.env"
if ($LASTEXITCODE -ne 0) { throw "Failed uploading silkwarp.env" }

& scp -P $Port $PrivKey $PubKey "${Remote}:/opt/silkwarp/rustdesk/"
if ($LASTEXITCODE -ne 0) { throw "Failed uploading RustDesk keypair" }

& scp -P $Port $WolScript "${Remote}:/opt/silkwarp/wol/silkwarp_wol.py"
if ($LASTEXITCODE -ne 0) { throw "Failed uploading silkwarp_wol.py" }

& scp -P $Port $DeployScript "${Remote}:/opt/silkwarp/deploy-relay-r720.sh"
if ($LASTEXITCODE -ne 0) { throw "Failed uploading deploy-relay-r720.sh" }

$RemoteCmd = "sed -i 's/\r$//' /opt/silkwarp/silkwarp.env /opt/silkwarp/deploy-relay-r720.sh /opt/silkwarp/wol/silkwarp_wol.py && chmod 600 /opt/silkwarp/silkwarp.env /opt/silkwarp/rustdesk/id_ed25519 && chmod +x /opt/silkwarp/deploy-relay-r720.sh && bash /opt/silkwarp/deploy-relay-r720.sh"
if ($EnableSshPort -gt 0) {
    $RemoteCmd += " --enable-ssh-port $EnableSshPort"
}

Write-Host "==> Running remote deployment on $TargetHost" -ForegroundColor Cyan
& ssh -p $Port $Remote $RemoteCmd
if ($LASTEXITCODE -ne 0) { throw "Remote deployment failed." }

Write-Host "[OK] Relay Node, RustDesk hbbr, and WOL Gateway deployed successfully!" -ForegroundColor Green
