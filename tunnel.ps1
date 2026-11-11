# Copyright 2026 M. Bryce Hudson
# SPDX-License-Identifier: Apache-2.0

# tunnel.ps1 - expose this copy's MCP server to the internet over a reverse
# proxy tunnel, so a friend's copy (or any MCP client) can reach it off-LAN.
#
#   tunnel.bat                    both tunnels, port auto-detected
#   tunnel.bat ngrok               ngrok only
#   tunnel.bat cloudflare 8090     cloudflared only, explicit port
#   tunnel.bat 8090                both tunnels against port 8090
#
# The friend's client URL is always <tunnel-url>[/router]/api/mcp-server with
# one header:  Authorization: Bearer <their friend token>
# (/router is there when Apache serves this folder, absent for php -S.)
#
# ngrok needs an authtoken once:  ngrok config add-authtoken <token>
# A reserved ngrok domain (free tier includes one) via -NgrokDomain, so the
# friend's saved URL survives restarts. cloudflared's quick tunnel needs no
# account; its URL is random on every launch.

param(
    [string]$Provider = 'both',
    [int]$Port = 0,
    [string]$NgrokDomain = '',
    [string]$XamppDir = 'C:\xampp'
)

$ErrorActionPreference = 'Stop'
$AppDir = $PSScriptRoot
if (-not $AppDir) { $AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path }

function Write-Step($msg)  { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    $msg" -ForegroundColor Yellow }
function Fail($msg) {
    Write-Host ""
    Write-Host "ERROR: $msg" -ForegroundColor Red
    Write-Host ""
    exit 1
}

# A bare number in the provider slot is a port:  tunnel.bat 8090
if ($Provider -match '^\d+$') { $Port = [int]$Provider; $Provider = 'both' }
$Provider = $Provider.ToLowerInvariant()
if ($Provider -notin @('ngrok', 'cloudflare', 'cf', 'both', 'all')) {
    Fail "Unknown provider '$Provider'. Use: ngrok | cloudflare | both  (optionally followed by a port)"
}
if ($Provider -eq 'all') { $Provider = 'both' }
if ($Provider -eq 'cf') { $Provider = 'cloudflare' }
if ($Port -lt 0 -or $Port -gt 65535) { Fail "Port '$Port' is out of range (1-65535)." }

# --- Port: explicit wins, else Apache's Listen line, else 8080 ------------
if ($Port -eq 0) {
    $Port = 8080
    $httpdConf = Join-Path $XamppDir 'apache\conf\httpd.conf'
    if (Test-Path -LiteralPath $httpdConf) {
        try {
            $m = [regex]::Match((Get-Content -LiteralPath $httpdConf -Raw), '(?m)^\s*Listen\s+(\d+)\s*$')
            if ($m.Success) { $Port = [int]$m.Groups[1].Value }
        } catch { }
    }
}

# --- Path prefix: Apache serves this folder at /router, php -S at / ------
$prefix = ''
$httpdConf = Join-Path $XamppDir 'apache\conf\httpd.conf'
$routerLink = Join-Path $XamppDir 'htdocs\router'
if ((Test-Path -LiteralPath $httpdConf) -and (Test-Path -LiteralPath $routerLink)) { $prefix = '/router' }

# --- The app must actually be listening ------------------------------------
Write-Step "Checking for the app on 127.0.0.1:$Port"
$listening = $false
try {
    $tcp = New-Object Net.Sockets.TcpClient
    $iar = $tcp.BeginConnect('127.0.0.1', $Port, $null, $null)
    if ($iar.AsyncWaitHandle.WaitOne(2000)) { $tcp.EndConnect($iar); $listening = $true }
    $tcp.Close()
} catch { }
if (-not $listening) {
    Fail "Nothing is listening on 127.0.0.1:$Port. Start the app first (start.bat), or pass its port: tunnel.bat $Provider <port>"
}
Write-Ok ("App is up at http://127.0.0.1:" + $Port + $prefix + "/ - MCP RPC at " + $prefix + "/api/mcp-server")

# --- Binaries ---------------------------------------------------------------
function Find-Bin($name) {
    try { return (Get-Command $name -ErrorAction Stop).Source } catch { return '' }
}
$ngrok = Find-Bin 'ngrok'
$cloudflared = Find-Bin 'cloudflared'
if ($Provider -in @('ngrok', 'both') -and -not $ngrok) {
    Write-Warn2 "ngrok not found on PATH. Install it:  winget install ngrok.ngrok  - then:  ngrok config add-authtoken <token>"
}
if ($Provider -in @('cloudflare', 'both') -and -not $cloudflared) {
    Write-Warn2 "cloudflared not found on PATH. Install it:  winget install cloudflare.cloudflared"
}
$wantNgrok = ($Provider -in @('ngrok', 'both')) -and $ngrok
$wantCf = ($Provider -in @('cloudflare', 'both')) -and $cloudflared
if (-not $wantNgrok -and -not $wantCf) {
    Fail "Nothing to launch. Install the missing tunnel binary (see above) and run again."
}

$rpcSuffix = "${prefix}/api/mcp-server"

if ($wantNgrok -and $wantCf) {
    # Both: ngrok gets its own window (its URL + dashboard stay visible there),
    # cloudflared runs here so its random URL is visible in this window.
    Write-Step "Starting ngrok in a new window (dashboard: http://127.0.0.1:4040)"
    $ngrokArgs = @('http', "127.0.0.1:$Port")
    if ($NgrokDomain) { $ngrokArgs = @('http', "--domain=$NgrokDomain", "127.0.0.1:$Port") }
    Start-Process -FilePath $ngrok -ArgumentList $ngrokArgs
    Write-Host ""
    Write-Host "  Friend URL shape:  https://<ngrok-host>${rpcSuffix}" -ForegroundColor Yellow
    Write-Host "  Header:  Authorization: Bearer <their friend token> (Config -> MCP Server)" -ForegroundColor Yellow
    Write-Host ""
    Write-Step "Starting Cloudflare quick tunnel here (Ctrl+C stops this one; close the ngrok window to stop that one)"
    & $cloudflared tunnel --url "http://127.0.0.1:$Port"
    exit $LASTEXITCODE
}

if ($wantNgrok) {
    Write-Step "Starting ngrok (dashboard: http://127.0.0.1:4040)"
    Write-Host "  Friend URL shape:  https://<ngrok-host>${rpcSuffix}" -ForegroundColor Yellow
    Write-Host "  Header:  Authorization: Bearer <their friend token> (Config -> MCP Server)" -ForegroundColor Yellow
    $ngrokArgs = @('http', "127.0.0.1:$Port")
    if ($NgrokDomain) { $ngrokArgs = @('http', "--domain=$NgrokDomain", "127.0.0.1:$Port") }
    & $ngrok @ngrokArgs
    exit $LASTEXITCODE
}

Write-Step "Starting Cloudflare quick tunnel (random URL each launch; needs no account)"
Write-Host "  Friend URL shape:  https://<trycloudflare-host>${rpcSuffix}" -ForegroundColor Yellow
Write-Host "  Header:  Authorization: Bearer <their friend token> (Config -> MCP Server)" -ForegroundColor Yellow
& $cloudflared tunnel --url "http://127.0.0.1:$Port"
exit $LASTEXITCODE
