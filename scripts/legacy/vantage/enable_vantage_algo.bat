@echo off
title Vantage - Algoritmik Ticaret Ac
cd /d "%~dp0..\..\.."
echo Vantage MT5 Algoritmik Ticaret aciliyor...
echo (Vantage MT5 penceresi acik ve gorunur olmali)
set PY=%~dp0..\..\..\runtime\python313\python.exe
if not exist "%PY%" set PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe
if not exist "%PY%" set PY=python
"%PY%" scripts\enable_vantage_autotrading.py --profile vantage
if errorlevel 1 (
  echo.
  echo BASARISIZ — Vantage MT5 acik mi? Manuel: ust bardaki yesil "Algoritmik Ticaret" dugmesine tikla.
  pause
  exit /b 1
)
echo.
echo Tamam — simdi mirror sync deneniyor...
curl -s -X POST http://127.0.0.1:8790/api/sync-mirror-pending
echo.
pause
