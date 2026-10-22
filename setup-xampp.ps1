# ============================================================
# setup-xampp.ps1 - one-click Apache + PHP for Loop Studio
# ============================================================
# Double-click setup-xampp.bat (it runs this file elevated). The script:
#   1. installs XAMPP (Apache + PHP only; MySQL/MariaDB, Perl, FileZilla,
#      Tomcat, Mercury and Webalizer are switched OFF - this app keeps its
#      data in JSON files under storage/ and needs no database),
#   2. links this folder into XAMPP's htdocs as /router,
#   3. points Apache at a free port and starts it,
#   4. creates the access token on first run,
#   5. opens the app.
#
# It is safe to run twice: an existing XAMPP is detected and reused, and every
# config edit is applied once (idempotent).
#
# Why XAMPP at all? Windows PHP cannot fork, so PHP's built-in server is a
# single process: one streamed model reply blocks every other request and a
# parallel agent fan-out hits "NetworkError". Real Apache serves them at once.

[CmdletBinding()]
param(
    [int]$Port = 8080,
    [string]$XamppDir = 'C:\xampp',
    [switch]$Repair
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir = (Resolve-Path -LiteralPath $AppDir).Path

function Write-Step($msg)  { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    $msg" -ForegroundColor Yellow }
function Fail($msg) {
    Write-Host ""
    Write-Host "ERROR: $msg" -ForegroundColor Red
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# --- 0. Elevate ---------------------------------------------------------
if (-not (Test-Admin)) {
    Write-Host "Requesting administrator rights (XAMPP installs to $XamppDir)..." -ForegroundColor Yellow
    $elevArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    if ($Port -ne 8080) { $elevArgs += @('-Port', "$Port") }
    if ($XamppDir -ne 'C:\xampp') { $elevArgs += @('-XamppDir', "`"$XamppDir`"") }
    if ($Repair) { $elevArgs += '-Repair' }
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $elevArgs
    exit 0
}

Write-Host ""
Write-Host "  Loop Studio - XAMPP setup" -ForegroundColor White
Write-Host "  App folder : $AppDir"
Write-Host "  XAMPP      : $XamppDir"
Write-Host ""

if (-not (Test-Path -LiteralPath (Join-Path $AppDir 'serve.php'))) {
    Fail "serve.php is not next to this script. Run setup-xampp.bat from inside the app folder."
}

$httpd  = Join-Path $XamppDir 'apache\bin\httpd.exe'
$phpExe = Join-Path $XamppDir 'php\php.exe'

# --- 1. Install XAMPP if missing ---------------------------------------
if ((Test-Path -LiteralPath $httpd) -and -not $Repair) {
    Write-Step "XAMPP already installed at $XamppDir - reusing it"
} else {
    Write-Step "Resolving the latest XAMPP release"
    try {
        $rel  = Invoke-RestMethod -Uri 'https://sourceforge.net/projects/xampp/best_release.json' -TimeoutSec 60
        $win  = $rel.platform_releases.windows
        if (-not $win -or -not $win.filename) { throw 'no Windows release in the API response' }
    } catch {
        Fail "Could not reach SourceForge to find the latest XAMPP: $($_.Exception.Message)"
    }
    $relPath = $win.filename.TrimStart('/')
    $file    = Split-Path $relPath -Leaf
    $url     = 'https://sourceforge.net/projects/xampp/files/' +
               (($relPath -split '/' | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/') +
               '/download'
    $sha     = $win.sha256sum

    $dest = Join-Path $env:TEMP $file
    if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue }

    Write-Step "Downloading $file (~$([math]::Round($win.bytes/1MB)) MB)"
    Write-Host "    $url"
    try {
        $wc = New-Object System.Net.WebClient
        # A browser-ish UA keeps SourceForge from handing back its HTML
        # "your download will start" page instead of the binary.
        $wc.Headers.Add('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) LoopStudioSetup/1.0')
        $wc.DownloadFile($url, $dest)
    } catch {
        Fail "Download failed: $($_.Exception.Message)"
    }

    if ($sha) {
        Write-Step "Checking the download against XAMPP's published SHA-256"
        $got = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower()
        if ($got -ne $sha.ToLower()) {
            Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue
            Fail "Downloaded file's checksum does not match the published one. Aborting; try again."
        }
        Write-Ok "checksum OK"
    }

    Write-Step "Installing XAMPP (Apache + PHP only; no database, no Perl)"
    # 8.x uses InstallBuilder. "unattended" is silent; components we do not
    # need are disabled so this stays a lean Apache+PHP runtime. --launchapps
    # is a 7.x-only flag and errors on 8.x, so it is NOT passed.
    $disable = 'xampp_mysql,xampp_filezilla,xampp_mercury,xampp_tomcat,xampp_perl,xampp_phpmyadmin,xampp_webalizer,xampp_sendmail'
    $common  = @('--mode', 'unattended', '--unattendedmodeui', 'none')
    $proc = Start-Process -FilePath $dest -ArgumentList ($common + @('--disable-components', $disable)) -Wait -PassThru
    if ($proc.ExitCode -ne 0) {
        Write-Warn2 "Component-restricted install returned $($proc.ExitCode); retrying a plain silent install"
        $proc = Start-Process -FilePath $dest -ArgumentList $common -Wait -PassThru
    }
    if ($proc.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $httpd)) {
        Fail "The XAMPP installer did not complete (exit $($proc.ExitCode)). Install it by hand from https://www.apachefriends.org/download.html, then run this again."
    }
    Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue
    Write-Ok "XAMPP installed"
}

# --- 2. Link the app into htdocs as /router ----------------------------
$htdocs  = Join-Path $XamppDir 'htdocs'
$linkDir = Join-Path $htdocs 'router'
Write-Step "Serving this folder at /router"
if (Test-Path -LiteralPath $linkDir) {
    $item = Get-Item -LiteralPath $linkDir -Force
    $isLink = ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    if ($isLink) {
        # A junction/ symlink: remove and recreate so it always points here.
        cmd /c rmdir "$linkDir" | Out-Null
    } elseif ((Get-ChildItem -LiteralPath $linkDir -Force | Measure-Object).Count -eq 0) {
        Remove-Item -LiteralPath $linkDir -Force   # empty stray folder
    } else {
        Write-Warn2 "htdocs\router already exists and is a normal folder; serving from there instead."
        $linkDir = $AppDir
    }
}
if (-not (Test-Path -LiteralPath $linkDir)) {
    cmd /c mklink /J "$linkDir" "$AppDir" | Out-Null
    if (-not (Test-Path -LiteralPath $linkDir)) { Fail "Could not create the htdocs\router link." }
}
Write-Ok "$linkDir  ->  $AppDir"

# --- 3. Configure Apache ------------------------------------------------
$confDir = Join-Path $XamppDir 'apache\conf'
$conf    = Join-Path $confDir 'httpd.conf'
if (-not (Test-Path -LiteralPath $conf)) { Fail "Apache config not found at $conf" }

# Pick a free port if the requested one is taken.
function Test-PortFree($p) {
    try {
        $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $p)
        $l.Start(); $l.Stop(); return $true
    } catch { return $false }
}
if (-not (Test-PortFree $Port)) {
    $start = $Port
    while ($Port -lt ($start + 40) -and -not (Test-PortFree $Port)) { $Port++ }
}

Write-Step "Pointing Apache at port $Port and enabling .htaccess"
$text = [IO.File]::ReadAllText($conf)

# Listen port (replace the default Listen line, whatever it is).
$text = [regex]::Replace($text, '(?m)^\s*Listen\s+\d+\s*$', "Listen $Port")
# ServerName with the same port (append one if the line is absent/commented).
if ($text -match '(?m)^\s*ServerName\s+') {
    $text = [regex]::Replace($text, '(?m)^\s*ServerName\s+.*$', "ServerName localhost:$Port")
} else {
    $text += "`r`nServerName localhost:$Port`r`n"
}
# Ensure the modules the app's .htaccess needs are loaded. access_compat is
# what makes the storage/ "Deny from all" rule work on Apache 2.4.
foreach ($mod in 'rewrite', 'headers', 'expires', 'access_compat') {
    $text = [regex]::Replace($text, "(?m)^\s*#\s*LoadModule\s+$($mod)_module\b", "LoadModule $mod`_module")
}
# Allow .htaccess (rewrite + cache headers) and file serving from htdocs.
$marker = '# --- Loop Studio ---'
if ($text -notmatch [regex]::Escape($marker)) {
    $text += @"

$marker
# Added by setup-xampp.ps1 so .htaccess (routing + cache policy) applies.
<Directory "$($htdocs.Replace('\','/'))">
    AllowOverride All
    Require all granted
</Directory>
"@
}
[IO.File]::WriteAllText($conf, $text, (New-Object Text.UTF8Encoding($false)))
Write-Ok "Apache configured"

# --- 4. Access token ----------------------------------------------------
if (Test-Path -LiteralPath $phpExe) {
    Write-Step "Checking the access token"
    Push-Location $AppDir
    try {
        $out = & $phpExe serve.php --ensure-token 2>$null
    } finally { Pop-Location }
    if ($out -and ($out -notmatch 'TOKEN=exists')) {
        $tok = ($out | Where-Object { $_ -match '^TOKEN=' } | Select-Object -First 1) -replace '^TOKEN=', ''
        if ($tok) {
            Write-Host ""
            Write-Host "    FIRST RUN - paste this into Config -> Access token in the app:" -ForegroundColor Yellow
            Write-Host "      $tok" -ForegroundColor White
            Write-Host ""
        }
    } else {
        Write-Ok "A token already exists"
    }
}

# --- 5. Start Apache ----------------------------------------------------
Write-Step "Starting Apache"
$running = Get-Process -Name httpd -ErrorAction SilentlyContinue
if ($running) {
    Write-Ok "Apache is already running"
} else {
    Start-Process -FilePath $httpd -WindowStyle Hidden
    Start-Sleep -Seconds 3
    if (-not (Get-Process -Name httpd -ErrorAction SilentlyContinue)) {
        $log = Join-Path $XamppDir 'apache\logs\error.log'
        Write-Warn2 "Apache exited right after starting. Last lines of its log:"
        if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Tail 12 | ForEach-Object { Write-Host "      $_" } }
        Fail "Apache did not stay up. Fix the issue above (often another program on port $Port) and run setup-xampp.bat again."
    }
    Write-Ok "Apache started on port $Port"
}

$url = "http://localhost:$Port/router/"
Write-Step "Opening $url"
Start-Process $url
Write-Host ""
Write-Ok "Done. To stop Apache later, close it from the XAMPP Control Panel or Task Manager."
Write-Host ""
Read-Host "Press Enter to close"
