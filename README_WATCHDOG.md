# Proxy Watchdog (Otomatik Yeniden Başlatma)

## Hızlı Başlangıç

`start_proxy.bat` dosyasını çift tıklayın. Proxy sunucusu watchdog altında çalışmaya başlar.

```bat
@echo off
cd /d "%~dp0"
node proxy_watchdog.js
pause
```

## Davranış

| Olay | Watchdog Tepkisi |
|---|---|
| Proxy düzgün başladı | Logla, çalışmaya devam |
| Proxy <5sn'de düştü | Exponential backoff (2s → 4s → 8s ... max 60s) |
| Proxy çalışırken düştü | 2sn sonra otomatik yeniden başlat |
| Saatte >20 restart | DURDUR (sonsuz döngü koruması) |
| Ctrl+C | Graceful shutdown (SIGTERM → 3sn → SIGKILL) |

## Ortam Değişkenleri (opsiyonel)

```
MAX_RESTARTS_PER_HOUR=20     # saatte max restart
MIN_UPTIME_MS=5000           # bunun altında crash = "hızlı crash" sayılır
BASE_DELAY_MS=2000           # normal restart gecikmesi
PROXY_SCRIPT=crt_ai_proxy_server.js
```

## Windows Servis Olarak Çalıştırma (kalıcı)

[NSSM](https://nssm.cc/) kullanarak boot'ta otomatik başlatma:

```cmd
nssm install CRTProxy "C:\Program Files\nodejs\node.exe" "D:\Projects\crt-scanner\proxy_watchdog.js"
nssm set CRTProxy AppDirectory "D:\Projects\crt-scanner"
nssm set CRTProxy Start SERVICE_AUTO_START
nssm start CRTProxy
```

Servisi durdurmak: `nssm stop CRTProxy`
Kaldırmak: `nssm remove CRTProxy confirm`

## Manuel Başlatma (Watchdog'suz)

Hala eski yöntemle başlatmak istersen:

```cmd
node crt_ai_proxy_server.js
```

Bu sürümde crash olursa **otomatik yeniden başlatma olmaz**.
