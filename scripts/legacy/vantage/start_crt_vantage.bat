@echo off
title CRT Scanner - Vantage LIVE Proxy (8791)
cd /d "%~dp0..\..\.."

echo ========================================
echo   CRT Scanner - Vantage LIVE (8791)
echo   (Opsiyonel mirror — varsayilan: Lotas only)
echo ========================================
echo Proje: %CD%
echo.

set ENV_FILE=.env.vantage
set PORT=8791

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8791.*LISTENING"') do (
  echo [bilgi] 8791 portu PID %%a - onceki Vantage proxy kapatiliyor...
  taskkill /PID %%a /F >nul 2>&1
)
timeout /t 2 /nobreak >nul

if not exist ".env.vantage" (
  echo [UYARI] .env.vantage bulunamadi!
  echo config\vantage\.env.vantage.example dosyasini proje kokune .env.vantage olarak kopyalayin.
  pause
  exit /b 1
)

echo [1] Vantage proxy basliyor (port 8791, ENV_FILE=.env.vantage)...
echo [2] Birincil dashboard: http://127.0.0.1:8790/
echo [3] Durdurmak icin Ctrl+C
echo.

node proxy_watchdog.js

pause
