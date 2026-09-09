@echo off
rem ============================================================
rem  七宝浏览器 - 启动脚本（诊断友好版）
rem  1) 清除系统级 ELECTRON_RUN_AS_NODE（会让 Electron 退化为
rem     Node 模式导致应用无法启动）
rem  2) Chromium 临时文件重定向到应用目录旁 _tmp/（避免写系统盘）
rem  3) 每一步都打印状态，任何异常都暂停等你查看
rem ============================================================
setlocal
title 七宝浏览器启动中...
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
echo [1/3] 准备临时目录...
if not exist "_tmp" mkdir "_tmp"
set TMP=%~dp0_tmp
set TEMP=%~dp0_tmp
echo [2/3] 检查 Electron 运行时...
if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo  *** 错误：未找到 electron 运行时 ***
  echo  请先在本目录执行:  npm install
  echo.
  pause
  exit /b 1
)
echo [3/3] 正在启动七宝浏览器窗口...
echo   （若 10 秒内没出现窗口，请把本窗口内容截图发我）
echo.
"node_modules\electron\dist\electron.exe" .
set EC=%errorlevel%
echo.
echo  应用已退出（代码 %EC%）
if "%EC%"=="0" (
  echo  正常退出。
) else (
  echo  *** 启动失败或异常退出（代码 %EC%）***
  echo  如果是代码 1 且有报错信息，截图发我排查。
)
echo.
pause
endlocal
