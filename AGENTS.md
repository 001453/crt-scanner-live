# AGENTS.md — Forex Scanner (AI asistan rehberi)

Bu dosya Cursor / AI asistanlar icin **tek dogru kaynak**tir. Baska klasordeki kopyalari duzenleme.

## Proje

- **Konum:** `D:\Projects\forex`
- **Platform:** MetaTrader 5, broker **Lotas** (`LotasCapital-Server`, port **8790** proxy)
- **Dashboard URL:** `http://127.0.0.1:8790/` (asla `file://`)

## Baslat / durdur

```bat
enable_lotas_algo.bat   # MT5 algo ac (CMD)
start_forex.bat         # proxy + watchdog + tarayici (CMD)
stop_forex.bat          # port 8790 kapat (CMD)
```

PowerShell'de ayni isler:

```powershell
.\enable_lotas_algo.ps1
.\start_forex.ps1
.\stop_forex.ps1
```

## Ana dosyalar (kok — tasima)

| Dosya | Rol |
|-------|-----|
| `crt_signals_v3.html` | UI + scanner + stratejiler + auto-execute |
| `crt_ai_proxy_server.js` | HTTP API, MT5, SQLite trade log |
| `proxy_watchdog.js` | Process supervisor |
| `edge_engine.js` | Edge bias engine |
| `.env` | MT5 login, PORT, ALLOW_REAL_TRADING |

`.env` proje kokunden okunur (`__dirname`).

## Strateji ekleme / duzenleme

Strateji mantigi **`crt_signals_v3.html` icinde** (tek dosya mimarisi):

- `detectIctLiquidity()` — ICT likidite
- `crtScan()` — core CRT
- `scanPairByIntervals()` — tarama havuzu
- `canAutoExecute()`, `isInstitutionalQualified()` — filtreler

Proxy tarafinda `strategy_tag` whitelist: `crt_ai_proxy_server.js` execute-order handler.

## Kullanici ayarlari (degistirme)

| Ayar | Deger |
|------|-------|
| Risk | %2 |
| fixedLotEnabled | false |
| Blacklist | EURGBP, EURNZD, USDHKD |
| scanIct | true |
| Vantage mirror | kapali |

## Yapma

- Downloads veya `archive/` icindeki eski HTML/JS uzerinde calisma
- Kok dosyalari alt klasore tasima (path kirilir)
- `.env` commit etme
- `stop_forex.bat` ile tum node.exe oldurme (artik sadece 8790)

## Dokumantasyon

- `docs/STRUCTURE.md` — dizin haritasi
- `docs/CRT_strateji_yol_haritasi.md` — strateji yol haritasi
- `docs/WATCHDOG.md` — watchdog / NSSM

## Vantage mirror

Opsiyonel, kapali. Dosyalar: `scripts/legacy/vantage/`
