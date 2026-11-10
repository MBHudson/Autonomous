@echo off
REM Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
REM
REM Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
REM
REM BryceFromIndiana@gmail.com
rem ============================================================
rem  Loop Studio - expose the MCP server over tunnel(s) (Windows)
rem ============================================================
rem  Double-click for both tunnels on the auto-detected port, or:
rem    tunnel.bat                  both tunnels, auto port
rem    tunnel.bat ngrok             ngrok only
rem    tunnel.bat cloudflare        Cloudflare quick tunnel only
rem    tunnel.bat both 8090         both tunnels against port 8090
rem    tunnel.bat 8090              same thing (a bare number is a port)
rem
rem  ngrok needs an authtoken once: ngrok config add-authtoken <token>
rem  cloudflared's quick tunnel needs no account.
setlocal
cd /d "%~dp0"

if not exist "tunnel.ps1" (
  echo.
  echo   tunnel.ps1 is missing from this folder, so there is nothing to start.
  echo   Re-extract the app and run this file again from the app's own folder.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tunnel.ps1" %*
set "RC=%errorlevel%"
if not "%RC%"=="0" (
  pause
  exit /b %RC%
)
rem Double-clicked with no arguments: keep the window open so the tunnel
rem URL can actually be read and copied.
if "%~1"=="" pause
exit /b %RC%
