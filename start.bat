@echo off
rem ============================================================
rem  Loop Studio - one-click start (Windows)
rem ============================================================
rem  Double-click this file. It does everything in one step:
rem    * first run: installs XAMPP (Apache + PHP only), links this folder
rem      into htdocs, configures Apache, creates the access token, starts
rem      Apache and opens the app;
rem    * later runs: starts Apache if needed and opens the app.
rem
rem  Apache is used because Windows PHP cannot fork: the built-in server
rem  serves one request at a time, so a streamed reply blocks every other
rem  agent. Apache runs them in parallel. The old single-threaded launcher
rem  is still available as start-php.bat.
rem
rem  Optional:  start.bat 8090      another port
rem             start.bat -Stop     stop Apache
rem             start.bat -Token    show the access token and wait
rem             start.bat -Check    report status only
rem             start.bat -PhpServer  built-in server (legacy, single-threaded)
setlocal
cd /d "%~dp0"

if not exist "start.ps1" (
  echo.
  echo   start.ps1 is missing from this folder, so there is nothing to start.
  echo   Re-extract the app and run this file again from the app's own folder.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set "RC=%errorlevel%"
if not "%RC%"=="0" (
  pause
  exit /b %RC%
)
rem Double-clicked with no arguments: keep the window open so the URL and any
rem first-run token can actually be read and copied.
if "%~1"=="" pause
exit /b %RC%
