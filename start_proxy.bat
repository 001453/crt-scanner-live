@echo off
REM CRT Proxy Watchdog Starter
REM Bu dosyayi cift tikla calistir. Proxy crash olursa watchdog yeniden baslatir.
REM Durdurmak icin pencerede Ctrl+C bas.

cd /d "%~dp0"
echo CRT Proxy Watchdog basliyor...
echo Calisma dizini: %CD%
echo.
node proxy_watchdog.js
pause
