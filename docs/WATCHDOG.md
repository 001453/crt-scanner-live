# Proxy Watchdog (Otomatik Yeniden Başlatma)

`start_forex.bat` → `scripts/start_forex_stack.ps1` proxy'yi **watchdog** altında arka planda başlatır.

## Davranış

| Olay | Watchdog Tepkisi |
|---|---|
| Proxy düzgün başladı | Logla, çalışmaya devam |
| Proxy <5sn'de düştü | Exponential backoff (2s → 4s ... max 60s) |
| Proxy çalışırken düştü | 2sn sonra otomatik yeniden başlat |
| Saatte >20 restart | DURDUR (sonsuz döngü koruması) |
| Ctrl+C (manuel mod) | Graceful shutdown |

## Ortam Değişkenleri (opsiyonel)

```
MAX_RESTARTS_PER_HOUR=20
MIN_UPTIME_MS=5000
BASE_DELAY_MS=2000
PROXY_SCRIPT=crt_ai_proxy_server.js
```

## Windows Servis (boot'ta otomatik)

[NSSM](https://nssm.cc/) ile:

```cmd
nssm install ForexProxy "C:\Program Files\nodejs\node.exe" "D:\Projects\forex\proxy_watchdog.js"
nssm set ForexProxy AppDirectory "D:\Projects\forex"
nssm set ForexProxy Start SERVICE_AUTO_START
nssm start ForexProxy
```

## Manuel (watchdog'suz — önerilmez)

```cmd
cd D:\Projects\forex
node crt_ai_proxy_server.js
```

Crash olursa otomatik yeniden başlatma **yok**.
