REM Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
REM
REM Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
REM
REM BryceFromIndiana@gmail.com

@echo off
rem ============================================================
rem  Loop Studio - one-click Windows setup (Apache + PHP via XAMPP)
rem ============================================================
rem  Double-click this file. It downloads and installs XAMPP with Apache and
rem  PHP only (no database), links this folder into htdocs as /router, starts
rem  Apache, creates the access token, and opens the app. It elevates to
rem  Administrator on its own (the XAMPP installer writes to C:\).
rem
rem  Extra options, if you ever need them:
rem     setup-xampp.bat -Port 9090
rem     setup-xampp.bat -XamppDir D:\xampp
rem     setup-xampp.bat -Repair        (re-run the XAMPP installer)
rem
rem  Linux / macOS do not need this: use ./start.sh.
setlocal
cd /d "%~dp0"

if not exist "setup-xampp.ps1" (
  echo setup-xampp.ps1 is missing - keep it next to this file.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-xampp.ps1" %*
