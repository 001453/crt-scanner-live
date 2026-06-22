@echo off
REM ESKI: Dogrudan watchdog baslatiyordu. Artik tam stack kullanin.
title Forex Scanner - Baslat (yönlendirme)
cd /d "%~dp0"
echo [bilgi] start_proxy.bat artik kullanilmiyor.
echo [bilgi] start_forex.bat kullaniliyor (proxy + health check + tarayici).
echo.
call "%~dp0start_forex.bat"
