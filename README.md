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
