@echo off
title Lotas - Algoritmik Ticaret Ac
cd /d "%~dp0"
echo Lotas MT5 Algoritmik Ticaret aciliyor...
echo (Lotas MT5 penceresi acik ve gorunur olmali)
set PY=%~dp0runtime\python313\python.exe
if not exist "%PY%" set PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe
if not exist "%PY%" set PY=python
"%PY%" scripts\enable_mt5_autotrading.py --profile lotas
if errorlevel 1 (
  echo.
  echo BASARISIZ — Lotas MT5 acik mi? Manuel: ust bardaki yesil "Algoritmik Ticaret" dugmesine tikla.
  pause
  exit /b 1
)
echo.
echo Tamam — Lotas algo trading acildi.
pause
