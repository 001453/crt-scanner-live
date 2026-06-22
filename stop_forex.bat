@echo off
title Forex Scanner - Durdur
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop_forex_stack.ps1"
pause
