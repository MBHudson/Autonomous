@echo off
REM Copyright M. Bryce Hudson 2026-2029 All Rights Reserved
REM
REM Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.
REM
REM BryceFromIndiana@gmail.com
rem Start Loop Studio on Windows with PHP's built-in server (LEGACY).
rem Single-threaded: fine for one agent at a time. For parallel agents use
rem start.bat, which runs the app under Apache instead.
rem
rem Double-click this file, or:  start-php.bat           (port 8080)
rem                             start-php.bat 8090      (another port)
rem
rem Installs what it needs on first run:
rem   * PHP 8.3 (winget) if no PHP is found
rem   * the PHP extensions the app uses (curl, openssl, mbstring, fileinfo, zip)
rem     -- switched on through storage\php-runtime.ini; your php.ini is not edited
rem   * a CA certificate bundle (tools\cacert.pem) so HTTPS calls verify
rem   * the Visual C++ runtime, if PHP cannot load its extensions without it
rem   * the access token (printed once)
rem
rem For many parallel agent calls use start.bat (Apache): the built-in server on
rem Windows is a SINGLE process (PHP cannot fork here), so a streamed reply
rem holds the only worker and a big fan-out can hit "NetworkError".
setlocal EnableExtensions
cd /d "%~dp0"

if not exist "serve.php" (
  echo.
  echo   serve.php is missing from this folder, so there is nothing to start.
  echo   Re-extract the app and run this file again from the app's own folder.
  echo.
  pause
  exit /b 1
)

if "%~1" NEQ "" (set "PORT=%~1") else (set "PORT=8080")
set "TMPOUT=%TEMP%\loopstudio-%RANDOM%.tmp"
set "HAVE_WINGET="
where winget >nul 2>&1 && set "HAVE_WINGET=1"

rem --- Locate PHP --------------------------------------------------------
rem Every later call uses "%PHP%" QUOTED, so a path with spaces works.
call :find_php

if not defined PHP (
  echo PHP was not found ^(Loop Studio needs 7.4 or newer^).
  if not defined HAVE_WINGET (
    echo.
    echo   winget is not available, so this has to be manual:
    echo     https://windows.php.net/download/  ^(Thread Safe ZIP^)
    echo     then add the php folder to your PATH, or run setup-xampp.bat.
    echo.
    pause
    exit /b 1
  )
  echo Installing PHP 8.3 with winget...
  winget install --id PHP.PHP.8.3 --exact --silent ^
        --accept-package-agreements --accept-source-agreements --disable-interactivity
  rem winget can report a non-zero code when PHP is already present; just look.
  call :find_php
  if not defined PHP (
    echo.
    echo   PHP could not be installed or found. Try by hand:
    echo     winget install PHP.PHP.8.3
    echo   or run setup-xampp.bat for a self-contained Apache+PHP.
    echo.
    pause
    exit /b 1
  )
)
echo Using PHP: %PHP%

rem --- CA certificate bundle ---------------------------------------------
if not exist "tools\cacert.pem" (
  if not exist "tools" mkdir "tools"
  echo Downloading CA certificates...
  curl.exe -sSL --max-time 60 -o "tools\cacert.pem" https://curl.se/ca/cacert.pem 2>nul
  if not exist "tools\cacert.pem" powershell -NoProfile -Command ^
    "try { Invoke-WebRequest -UseBasicParsing https://curl.se/ca/cacert.pem -OutFile 'tools\cacert.pem' } catch {}"
  if not exist "tools\cacert.pem" echo   ^(could not download it; HTTPS certificate checks may fail^)
)

rem --- PHP extensions ----------------------------------------------------
call :setup_php
if errorlevel 1 (
  if defined HAVE_WINGET (
    echo Installing the Visual C++ runtime PHP needs...
    winget install --id Microsoft.VCRedist.2015+.x64 --exact --silent ^
          --accept-package-agreements --accept-source-agreements --disable-interactivity >nul 2>&1
    call :setup_php
  )
)
if errorlevel 1 (
  echo.
  echo   PHP cannot load the curl extension, so the app could not reach any
  echo   model. See the message above, or run setup-xampp.bat instead.
  echo.
  pause
  exit /b 1
)

rem --- Free port ---------------------------------------------------------
rem Captured through a temp file: a `for /f` around a quoted program path is
rem mangled by cmd.
"%PHP%" %PHPARGS% serve.php --free-port %PORT% > "%TMPOUT%" 2>nul
set "PORT="
set /p PORT=<"%TMPOUT%"
del "%TMPOUT%" >nul 2>&1
if not defined PORT set "PORT=8080"

rem --- Preflight + access token ------------------------------------------
"%PHP%" %PHPARGS% serve.php --check
if errorlevel 1 (
  echo.
  echo   Preflight failed - see the message above.
  echo.
  pause
  exit /b 1
)

"%PHP%" %PHPARGS% serve.php --ensure-token > "%TMPOUT%" 2>nul
set "NEWTOKEN="
set /p NEWTOKEN=<"%TMPOUT%"
del "%TMPOUT%" >nul 2>&1
rem Empty means --ensure-token produced nothing (it failed): treat as "exists"
rem so we never print a blank token.
if not defined NEWTOKEN set "NEWTOKEN=TOKEN=exists"
if not "%NEWTOKEN%"=="TOKEN=exists" (
  echo.
  echo   First run: paste this token into Config -^> Access token in the app:
  echo.
  rem Strip the leading "TOKEN=" (6 chars). The old %%NEWTOKEN:TOKEN=%% only
  rem removed the word, so the printed token started with "=" and pasting it
  rem as shown gave a wrong token.
  echo     %NEWTOKEN:~6%
  echo.
)

echo Loop Studio at http://127.0.0.1:%PORT%/  ^(close this window to stop it^)
echo ^(Windows PHP is single-threaded: for parallel agents, use start.bat^)
start "" "http://127.0.0.1:%PORT%/"
"%PHP%" %PHPARGS% -S 127.0.0.1:%PORT% serve.php
exit /b %errorlevel%

rem =======================================================================
:find_php
set "PHP="
where php >nul 2>&1 && set "PHP=php"
if not defined PHP if exist "%ProgramFiles%\PHP" (
  for /f "delims=" %%D in ('dir /b /ad /o-n "%ProgramFiles%\PHP" 2^>nul') do (
    if not defined PHP if exist "%ProgramFiles%\PHP\%%D\php.exe" set "PHP=%ProgramFiles%\PHP\%%D\php.exe"
  )
)
if not defined PHP if exist "%LOCALAPPDATA%\Programs\PHP" (
  for /f "delims=" %%D in ('dir /b /ad /o-n "%LOCALAPPDATA%\Programs\PHP" 2^>nul') do (
    if not defined PHP if exist "%LOCALAPPDATA%\Programs\PHP\%%D\php.exe" set "PHP=%LOCALAPPDATA%\Programs\PHP\%%D\php.exe"
  )
)
rem Where winget actually unpacks the PHP package. Found here, a freshly
rem installed PHP works in THIS window -- no "open a new terminal" restart.
if not defined PHP if exist "%LOCALAPPDATA%\Microsoft\WinGet\Packages" (
  for /f "delims=" %%D in ('dir /b /ad /o-n "%LOCALAPPDATA%\Microsoft\WinGet\Packages\PHP.PHP.*" 2^>nul') do (
    if not defined PHP if exist "%LOCALAPPDATA%\Microsoft\WinGet\Packages\%%D\php.exe" set "PHP=%LOCALAPPDATA%\Microsoft\WinGet\Packages\%%D\php.exe"
  )
)
if not defined PHP if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\php.exe" set "PHP=%LOCALAPPDATA%\Microsoft\WinGet\Links\php.exe"
if not defined PHP if exist "C:\xampp\php\php.exe" set "PHP=C:\xampp\php\php.exe"
if not defined PHP if exist "C:\php\php.exe" set "PHP=C:\php\php.exe"
exit /b 0

rem Enables the extensions this PHP is missing (storage\php-runtime.ini) and
rem sets PHPARGS to use it. errorlevel 1 when curl still cannot load.
:setup_php
set "PHPARGS="
set "PHPINI="
"%PHP%" serve.php --setup > "%TMPOUT%"
set "SETUPRC=%errorlevel%"
set /p PHPINI=<"%TMPOUT%"
del "%TMPOUT%" >nul 2>&1
rem The line is "PHPINI=<path>": drop the name, then the "=".
if defined PHPINI set "PHPINI=%PHPINI:PHPINI=%"
if defined PHPINI set "PHPINI=%PHPINI:~1%"
if defined PHPINI set PHPARGS=-c "%PHPINI%"
if not "%SETUPRC%"=="0" exit /b 1
exit /b 0
