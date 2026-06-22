# Forex Scanner — Proje Yapisi

Tek calisan kopya: **`D:\Projects\forex`**

Downloads veya baska yerdeki `crt_signals_v3.html` / `crt_ai_proxy_server.js` dosyalari **eski** — kullanmayin.

## Gunluk kullanim

```
1. Lotas MT5 acik + algo acik     → enable_lotas_algo.bat
2. Stack baslat                   → start_forex.bat
3. Dashboard                      → http://127.0.0.1:8790/
4. Durdur                         → stop_forex.bat
```

> Dashboard'u `file://` ile acmayin.

## Dizin haritasi

```
forex/
├── crt_signals_v3.html       # Dashboard + tum strateji mantigi (tek HTML)
├── crt_ai_proxy_server.js    # Node API — MT5 koprusu (port 8790)
├── edge_engine.js            # Session edge bias
├── proxy_watchdog.js         # Crash sonrasi otomatik yeniden baslat
├── start_forex.bat           # ANA baslat (PowerShell stack)
├── stop_forex.bat            # Durdur (port 8790)
├── start_proxy.bat           # Eski isim → start_forex.bat yonlendirir
├── start_crt.bat             # Eski isim → start_forex.bat yonlendirir
├── enable_lotas_algo.bat     # Lotas MT5 algoritmik ticaret ac
├── .env                      # Lotas kimlik bilgileri (gitignore)
├── README.md
├── AGENTS.md                 # AI asistan icin tek kaynak
│
├── data/                     # Calisma zamanı verisi
│   ├── trade_log.db
│   ├── manage_cfg.json
│   ├── edges.json
│   └── *.log
│
├── scripts/
│   ├── start_forex_stack.ps1 # Arka plan baslat + health + tarayici
│   ├── stop_forex_stack.ps1
│   ├── enable_mt5_autotrading.py
│   ├── backtest_*.py
│   └── legacy/vantage/       # Opsiyonel Vantage mirror (kapali)
│
├── docs/
│   ├── STRUCTURE.md          # Bu dosya
│   ├── WATCHDOG.md
│   └── CRT_strateji_yol_haritasi.md
│
├── config/
│   └── vantage/              # Ornek .env (mirror icin)
│
├── archive/                  # Eski / referans dosyalar
│   └── downloads_legacy/
│
├── knowledge/                # PDF referanslar (gitignore buyuk dosyalar)
└── runtime/python313/        # Bundled Python + MetaTrader5
```

## Mimari

```
crt_signals_v3.html (tarayici, 120s tarama)
        │ POST /api/broker-candles, /api/execute-order, /api/health
        ▼
crt_ai_proxy_server.js (Node, :8790)
        │ Python MetaTrader5
        ▼
MT5 terminal64.exe (LotasCapital-Server)
```

## Stratejiler

| ID | Aciklama |
|----|----------|
| `core` | CRT sweep + onay |
| `ict_liquidity` | HTF BSL/SSL sweep + MSS + LTF FVG/OB |
| `turtle_sopa` | Turtle soup varyanti |
| `vwap_reclaim` | VWAP reclaim |
| `sr_breakout` | S/R breakout |
| `lat_flash` | LAT flash |

## Kullanici profili (Lotas)

- Risk: **%2** (sabit lot kapali)
- Blacklist: **EURGBP**, **EURNZD**, **USDHKD**
- Vantage mirror: **kapali**
- ICT tarama: **acik**

Profil anahtarlari (localStorage): `crt_user_profile_lotas_2pct_v1`, `crt_ict_liquidity_v1`

## Loglar

- `data/proxy_stderr.log` — proxy hatalari
- `data/proxy_stdout.log` — proxy cikti

## Eski dosyalar

| Eski | Yeni |
|------|------|
| `D:\Projects\crt-scanner` | `D:\Projects\forex` |
| Downloads/crt_signals_v3.html | `forex/crt_signals_v3.html` |
| start_proxy.bat (dogrudan watchdog) | `start_forex.bat` |
| README_WATCHDOG.md (kok) | `docs/WATCHDOG.md` |
| Untitled (UI dump) | `archive/ui_snapshot_untitled.txt` |
