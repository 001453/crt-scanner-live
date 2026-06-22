# Forex Scanner Live

MT5 tabanli CRT + ICT Likidite tarayicisi (Lotas).

**Tek proje konumu:** `D:\Projects\forex`  
Downloads'taki eski kopyalar kullanilmaz — bkz. `archive/downloads_legacy/`

## Hizli baslat

**PowerShell** (onerilen — proje klasorundayken):

```powershell
cd D:\Projects\forex
.\enable_lotas_algo.ps1
.\start_forex.ps1
```

**CMD** veya cift tik:

```bat
enable_lotas_algo.bat
start_forex.bat
```

> PowerShell'de `.bat` dosyalari icin `.\` sart: `.\start_forex.bat`

1. **Lotas MT5** acik + algoritmik ticaret → yukaridaki komutlar
2. Tarayici → **http://127.0.0.1:8790/**

> Dashboard'u `file://` ile acmayin.

## Durdur

PowerShell: `.\stop_forex.ps1`  
CMD: `stop_forex.bat` veya `scripts\stop_forex_stack.ps1`

## Dosyalar

| Dosya | Rol |
|-------|-----|
| `crt_signals_v3.html` | Dashboard + stratejiler |
| `crt_ai_proxy_server.js` | MT5 koprusu (:8790) |
| `AGENTS.md` | AI asistan rehberi |
| `docs/STRUCTURE.md` | Tam dizin haritasi |

## Sorun giderme

| Sorun | Cozum |
|-------|--------|
| PROXY ULASILAMIYOR | `start_forex.bat` calistir |
| MT5 OFF | Lotas terminal ac + login |
| Eski HTML kullaniliyor | Sadece bu klasordeki v3 dosyasini ac |

Log: `data/proxy_stderr.log`

## Eski bat dosyalari

- `start_proxy.bat` → `start_forex.bat` yonlendirir
- `start_crt.bat` / `stop_crt.bat` → eski isim, yonlendirme
- Vantage mirror → `scripts/legacy/vantage/` (kapali)

## Run (remote UI + VPS proxy, CORS-free pattern)

MT5 ve `MetaTrader5` Python kutuphanesi **yalnizca Windows** uzerinde, **MT5 terminalinin acik oldugu makinede** calisir.

1. **Proxy sunucusu** (MT5'nin oldugu Windows'ta): `.env` icinde ornegin `CRT_LISTEN_HOST=0.0.0.0`, `PORT=8790`, gizli bir `CRT_PROXY_TOKEN=...`
2. **Dashboard**: `crt_signals_v3.html` dosyasini HTTPS uzerinden yayinlayin ve URL'ye proxy ekleyin:  
   `https://example.com/crt_signals_v3.html?proxy=https://api.example.com`  
   Token: `localStorage.setItem('crt_proxy_token','...')`

Kaynak repo: [001453/crt-scanner-live](https://github.com/001453/crt-scanner-live).

## Ucretsiz panel (GitHub Pages)

- GitHub Actions ile `crt_signals_v3.html` Pages'e kopyalanir (`index.html`).
- **iPhone / Safari:** API adresi **https://** olmali (mixed content engeli).

Ornek: `https://<kullanici>.github.io/<repo>/?proxy=https://api.sizin-domain.com`
