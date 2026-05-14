# CRT Scanner Live

MT5-based CRT (Candle Range Theory) scanner with:
- Multi-interval sequential scanning
- AI-assisted signal review
- Risk/lot sizing and one-click order planning
- Local proxy backend for AI + broker candle bridge

## Files
- `crt_signals_v3.html` - dashboard UI and scanner logic
- `crt_ai_proxy_server.js` - local proxy for OpenAI + MT5 candle endpoint

## Run (local)
1. Start proxy:
   - `node crt_ai_proxy_server.js`
2. Serve UI from project folder:
   - `py -m http.server 9090`
3. Open:
   - `http://127.0.0.1:9090/crt_signals_v3.html`

## Run (remote UI + VPS proxy, CORS-free pattern)

MT5 ve `MetaTrader5` Python kutuphanesi **yalnizca Windows** uzerinde, **MT5 terminalinin acik oldugu makinede** calisir. Bu yuzden “canli” kurulum tipik olarak: **Windows VPS veya ev PC** (Node proxy + MT5) + istege bagli **statik arayuz** (GitHub Pages, S3, kendi domaininiz).

1. **Proxy sunucusu** (MT5’nin oldugu Windows’ta): `.env` icinde ornegin `CRT_LISTEN_HOST=0.0.0.0`, `PORT=8787`, gizli bir `CRT_PROXY_TOKEN=...`, yol ve anahtarlar. Onune **HTTPS** icin Caddy veya nginx reverse proxy koymaniz tavsiye edilir.
2. **Dashboard**: `crt_signals_v3.html` dosyasini herhangi bir HTTPS uzerinden yayinlayin ve ilk acilista adres cubuguna proksi taban URL’yi ekleyin, ornek:  
   `https://example.com/crt_signals_v3.html?proxy=https://api.example.com`  
   Bu deger `localStorage`’a `crt_proxy_base` olarak yazilir. Token kullaniyorsaniz tarayici konsolunda:  
   `localStorage.setItem('crt_proxy_token','CRT_PROXY_TOKEN ile ayni deger')`
3. API zaten `Access-Control-Allow-Origin: *` ile yanit verir; tarayici farkli origin’den **CORS engeli olmadan** cagirabilir (token varsa `X-CRT-Token` otomatik eklenir).

**Guvenlik:** Internete `CRT_LISTEN_HOST=0.0.0.0` ile actiginiz proxy, MT5 emir ve hesap uclarini tasir. Mutlaka `CRT_PROXY_TOKEN` + TLS ve mumkunse IP kisitlamasi kullanin.

Kaynak repo: [001453/crt-scanner-live](https://github.com/001453/crt-scanner-live).

## Ucretsiz panel (GitHub Pages) + Apple (iPhone / iPad / Mac)

- Bu repoda **GitHub Actions** ile sadece `crt_signals_v3.html` **ucretsiz** olarak Pages’e kopyalanir (`index.html`). `main` veya `master` dalina push yeterli; repoda **Settings > Pages > Build: GitHub Actions** secili olmali.
- **iPhone / Safari:** Sayfa **HTTPS** oldugu icin API adresi de **https://...** olmali; duz `http://IP:8787` genelde **engellenir** (mixed content). Cozum: proxy onunde **TLS** (Caddy / Cloudflare Tunnel / nginx + sertifika).
- **Bot / MT5 / Python koprusu** bu projede **Windows** uzerinde calisir; **tamamen Apple cihazda veya tamamen ucretsiz bulutta** kosacak sekilde tasima **mumkun degil**. Apple tarafi **yalnizca tarayicidan panel** icin uygundur; kopru icin en az bir **Windows ortami** (ucuz VPS veya baska bir Windows PC) gerekir; kendi PC’nizi kullanmak istemezseniz secenek **Windows VPS + HTTPS** (genelde ucretsiz degil, dusuk ucret).

Ornek (Pages URL’si + HTTPS proxy):

`https://<kullanici>.github.io/<repo>/?proxy=https://api.sizin-domain.com`
