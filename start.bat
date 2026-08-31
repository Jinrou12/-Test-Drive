@echo off
title PC Optimizer & Drive C Manager
color 0A
echo ========================================================
echo   Launching PC Optimizer & Drive C Transfer Tool...
echo ========================================================
echo.
cd /d "%~dp0"

start http://localhost:3000
node server.js
pause
