@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul

rem 便携包优先使用内置 runtime\node.exe，无需系统安装 Node.js
set "NODE_CMD=node"
if exist "%~dp0runtime\node.exe" set "NODE_CMD=%~dp0runtime\node.exe"

if "%NODE_CMD%"=="node" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [错误] 未检测到 Node.js。请使用便携包中的 runtime\node.exe，或安装 Node.js 22 或更高版本：https://nodejs.org/
    pause
    exit /b 1
  )
)

if not exist node_modules (
  if exist "%~dp0runtime\node.exe" (
    echo [错误] 便携包缺少 node_modules，请重新解压完整安装包。
    pause
    exit /b 1
  )
  echo 首次运行，正在安装依赖（约 1-2 分钟）...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

echo 正在启动服务...
"%NODE_CMD%" "%~dp0launcher.mjs"

echo.
echo 服务已停止。
pause
