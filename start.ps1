# Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
#
# Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
#
# BryceFromIndiana@gmail.com

# ============================================================
# start.ps1 - one-click launcher for Loop Studio on Windows
# ============================================================
# Double-click start.bat. This does everything in one step:
#   * first run: installs XAMPP (Apache + PHP only), links this folder into
#     htdocs, configures Apache, creates the access token, and starts it;
#   * later runs: starts Apache if needed and opens the app.
#
# Apache is used rather than PHP's built-in server because Windows PHP cannot
# fork: `php -S` serves one request at a time, so a streamed model reply blocks
# every other agent. Apache serves them concurrently, which parallel fan-out
# needs. The old single-threaded launcher is kept as start-php.bat.
#
# Optional arguments (rarely needed):
#   start.bat -Port 8090    move Apache to another port (reconfigures once)
#   start.bat -Stop         stop Apache
#   start.bat -Check        report status and exit without starting
#   start.bat -Token        print the access token and wait so it can be copied
#   start.bat -PhpServer    run the built-in server instead (legacy)

[CmdletBinding()]
param(
    [int]$Port = 0,
    [string]$XamppDir = 'C:\xampp',
    [switch]$Stop,
    [switch]$Token,
    [switch]$PhpServer,
    [switch]$Check
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

if (-not (Test-Path -LiteralPath (Join-Path $AppDir 'serve.php'))) {
    Fail "serve.php is not next to this script. Run start.bat from inside the app folder."
}

$httpd  = Join-Path $XamppDir 'apache\bin\httpd.exe'
$phpExe = Join-Path $XamppDir 'php\php.exe'
$conf   = Join-Path $XamppDir 'apache\conf\httpd.conf'
$log    = Join-Path $XamppDir 'apache\logs\error.log'

function Read-AccessToken {
    $cfgPath = Join-Path $AppDir 'storage\config.json'
    if (-not (Test-Path -LiteralPath $cfgPath)) { return '' }
    try {
        $cfg = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
        if ($cfg.sandbox -and $cfg.sandbox.token) { return [string]$cfg.sandbox.token }
    } catch { }
    return ''
}

if ($Token) {
    $accessToken = Read-AccessToken
    if (-not $accessToken -and (Test-Path -LiteralPath $phpExe)) {
        Push-Location $AppDir
        try {
            $out = (& $phpExe serve.php --ensure-token 2>$null) -join "`n"
            $m = [regex]::Match($out, '(?m)^TOKEN=(.+?)\s*$')
            if ($m.Success -and $m.Groups[1].Value -ne 'exists') {
                $accessToken = $m.Groups[1].Value
            }
        } finally { Pop-Location }
    }
    Write-Host ""
    if ($accessToken) {
        Write-Host "  Access token (paste into Config -> Access token):" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "    $accessToken" -ForegroundColor White
        Write-Host ""
    } else {
        Write-Host "  No access token yet. Run start.bat once to create one." -ForegroundColor Yellow
        Write-Host ""
    }
    Read-Host "Press Enter to close"
    exit 0
}

if ($PhpServer) {
    Write-Step "Starting PHP's built-in server (single-threaded legacy mode)"
    & (Join-Path $AppDir 'start-php.bat')
    exit $LASTEXITCODE
}

if ($Stop) {
    $procs = @(Get-Process -Name httpd -ErrorAction SilentlyContinue)
    if ($procs.Count -gt 0) {
        Write-Step "Stopping Apache"
        # XAMPP's Apache is normally a console process, not a Windows service,
        # so "httpd -k stop" (which targets a service) does nothing. End the
        # parent and its worker processes directly.
        $procs | Stop-Process -Force -ErrorAction SilentlyContinue
        for ($i = 0; $i -lt 20 -and (Get-Process -Name httpd -ErrorAction SilentlyContinue); $i++) {
            Start-Sleep -Milliseconds 250
        }
        if (Get-Process -Name httpd -ErrorAction SilentlyContinue) {
            # Apache may have been started by the elevated setup script. Ask
            # for rights once rather than failing with an access-denied loop.
            Write-Warn2 "Apache was started with administrator rights; requesting them to stop it"
            try {
                Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -ArgumentList @(
                    '-NoProfile', '-Command', 'Get-Process httpd -ErrorAction SilentlyContinue | Stop-Process -Force'
                )
            } catch { }
            Start-Sleep -Milliseconds 750
            if (Get-Process -Name httpd -ErrorAction SilentlyContinue) {
                Fail "Apache is still running. Close it from the XAMPP Control Panel or Task Manager."
            }
        }
        Write-Ok "Apache stopped"
    } else {
        Write-Ok "Apache is not running"
    }
    exit 0
}

# --- First run: install XAMPP and configure it -------------------------
# setup-xampp.ps1 elevates, downloads/installs XAMPP, links this folder into
# htdocs, writes the Apache config, creates the token, starts Apache and opens
# the app. Once it has run, this script takes over for every later launch.
function Invoke-Setup {
    $setup = Join-Path $AppDir 'setup-xampp.ps1'
    if (-not (Test-Path -LiteralPath $setup)) {
        Fail "setup-xampp.ps1 is missing. Keep it next to start.bat."
    }
    $setupArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$setup`"")
    if ($Port -ne 0) { $setupArgs += @('-Port', "$Port") }
    if ($XamppDir -ne 'C:\xampp') { $setupArgs += @('-XamppDir', "`"$XamppDir`"") }
    Write-Step "First run: installing XAMPP (Apache + PHP) and configuring the app"
    Start-Process -FilePath 'powershell.exe' -ArgumentList $setupArgs -Wait
}

if (-not (Test-Path -LiteralPath $httpd) -or -not (Test-Path -LiteralPath $conf)) {
    Invoke-Setup
    exit 0
}

# A configured Apache has the marker setup-xampp.ps1 writes. Without it the
# app would be served but .htaccess routing/security would be ignored, so run
# the setup script once to finish configuring.
$confText = Get-Content -LiteralPath $conf -Raw
if ($confText -notmatch [regex]::Escape('# --- Loop Studio ---')) {
    Invoke-Setup
    exit 0
}

# --- Port ---------------------------------------------------------------
$confPort = 8080
$m = [regex]::Match($confText, '(?m)^\s*Listen\s+(\d+)\s*$')
if ($m.Success) { $confPort = [int]$m.Groups[1].Value }
if ($Port -eq 0) {
    $Port = $confPort
} elseif ($Port -ne $confPort -and -not $Check) {
    # Apache's own config still has the old port; let setup rewrite it once.
    Invoke-Setup
    exit 0
}

# --- Keep the htdocs link pointing at this folder ------------------------
$htdocs  = Join-Path $XamppDir 'htdocs'
$linkDir = Join-Path $htdocs 'router'
$needsLink = $true
if (Test-Path -LiteralPath $linkDir) {
    try {
        $target = @((Get-Item -LiteralPath $linkDir -Force).Target)[0]
        if ($target -and ((Resolve-Path -LiteralPath $target).Path -eq (Resolve-Path -LiteralPath $AppDir).Path)) {
            $needsLink = $false
        }
    } catch { }
}
if ($needsLink) {
    Write-Step "Linking this folder into XAMPP's htdocs"
    if (Test-Path -LiteralPath $linkDir) {
        $item = Get-Item -LiteralPath $linkDir -Force
        $isLink = ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
        if ($isLink) { cmd /c rmdir "$linkDir" | Out-Null }
    }
    if (-not (Test-Path -LiteralPath $linkDir)) {
        cmd /c mklink /J "$linkDir" "$AppDir" | Out-Null
    }
    if (-not (Test-Path -LiteralPath $linkDir)) {
        Write-Warn2 "Could not create $linkDir; running setup with administrator rights"
        Invoke-Setup
        exit 0
    }
    Write-Ok "$linkDir  ->  $AppDir"
}

# --- Preflight + access token -------------------------------------------
Write-Step "Checking PHP and the access token"
$preflight = & $phpExe serve.php --check 2>&1
if ($LASTEXITCODE -ne 0) {
    $preflight | ForEach-Object { Write-Host "    $_" }
    Fail "Preflight failed. If a PHP extension is missing, run setup-xampp.bat -Repair."
}
$tokenOut = ((& $phpExe serve.php --ensure-token 2>$null) -join "`n").Trim()
$newToken = ''
$m = [regex]::Match($tokenOut, '(?m)^TOKEN=(.+?)\s*$')
if ($m.Success -and $m.Groups[1].Value -ne 'exists') { $newToken = $m.Groups[1].Value }
if ($newToken) {
    Write-Host ""
    Write-Host "    FIRST RUN - paste this into Config -> Access token in the app:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "      $newToken" -ForegroundColor White
    Write-Host ""
    if (-not $Check -and [Environment]::UserInteractive) {
        # Keep the window open: the whole point is to let the user copy it.
        Read-Host "Press Enter after copying the token"
    }
}

$url = "http://localhost:$Port/router/"
$running = Get-Process -Name httpd -ErrorAction SilentlyContinue

if ($Check) {
    if ($running) { Write-Ok "Apache is running" } else { Write-Warn2 "Apache is not running" }
    Write-Ok "URL: $url"
    exit 0
}

# --- Start Apache if needed ---------------------------------------------
if (-not $running) {
    Write-Step "Starting Apache (multi-threaded)"
    try {
        Start-Process -FilePath $httpd -WindowStyle Hidden | Out-Null
    } catch {
        Fail "Could not start Apache: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds 2
    if (-not (Get-Process -Name httpd -ErrorAction SilentlyContinue)) {
        if (Test-Path -LiteralPath $log) {
            Write-Warn2 "Apache exited immediately. Last lines of its log:"
            Get-Content -LiteralPath $log -Tail 10 | ForEach-Object { Write-Host "      $_" }
        }
        Fail "Apache did not stay up. Port $Port may be in use. Try: setup-xampp.bat -Port 8090"
    }
    Write-Ok "Apache started on port $Port"
} else {
    Write-Ok "Apache is already running on port $Port"
}

Write-Step "Opening $url"
Start-Process $url
Write-Host ""
Write-Ok "Loop Studio is running at $url  (agents run in parallel)"
Write-Ok "Stop it with: start.bat -Stop"
Write-Host ""
