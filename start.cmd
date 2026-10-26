@echo off
setlocal EnableExtensions
cd /d "%~dp0"
chcp 65001 >nul

set "NODE_CMD=node"
set "USE_RUNTIME=0"
if exist "%~dp0runtime\node.exe" (
  set "NODE_CMD=%~dp0runtime\node.exe"
  set "USE_RUNTIME=1"
)

if "%USE_RUNTIME%"=="0" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] Node.js not found.
    echo Install Node.js 22+ or use the portable package that contains runtime\node.exe.
    pause
    exit /b 1
  )
)

if not exist "%~dp0node_modules" (
  if "%USE_RUNTIME%"=="1" (
    echo [ERROR] node_modules is missing from this portable package.
    echo Please extract the complete package again.
    pause
    exit /b 1
  )
  echo First run: installing dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [ERROR] npm install failed. Check the network and retry.
    pause
    exit /b 1
  )
)

echo Starting weixin-auto...
"%NODE_CMD%" "%~dp0launcher.mjs"

echo.
echo Service stopped.
pause
