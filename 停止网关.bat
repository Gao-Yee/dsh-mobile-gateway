@echo off
rem 双击停止 dsh-mobile-gateway
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-gateway.ps1"
pause
