@echo off
rem ============================================================
rem  七宝浏览器 - 启动脚本
rem  1) 若系统设置了 ELECTRON_RUN_AS_NODE=1（会让 Electron 退化为
rem     Node 模式导致应用无法启动），启动前先清除它
rem  2) 把 Chromium 临时文件重定向到应用目录旁，避免占用系统盘空间
rem ============================================================
setlocal
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
if not exist "_tmp" mkdir "_tmp"
set TMP=%~dp0_tmp
set TEMP=%~dp0_tmp
if not exist "node_modules\electron\dist\electron.exe" (
  echo [错误] 未找到 electron 运行时，请先执行: npm install
  pause
  exit /b 1
)
"node_modules\electron\dist\electron.exe" "%~dp0" %*
if errorlevel 1 (
  echo.
  echo 应用已退出（代码 %errorlevel%）
  pause
)
endlocal
