@echo off
title Forex Scanner - Baslat
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start_forex_stack.ps1"
if errorlevel 1 pause
