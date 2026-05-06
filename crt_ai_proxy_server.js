const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 8787);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_URL = process.env.OPENAI_URL || 'https://api.openai.com/v1/responses';
const OANDA_API_KEY = process.env.OANDA_API_KEY;
const OANDA_ENV = (process.env.OANDA_ENV || 'practice').toLowerCase();
const OANDA_BASE_URL = OANDA_ENV === 'live'
  ? 'https://api-fxtrade.oanda.com/v3'
  : 'https://api-fxpractice.oanda.com/v3';

function writeJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString('utf8');
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function handleAnalyze(req, res) {
  if (!OPENAI_API_KEY) {
    writeJson(res, 500, {
      error: 'OPENAI_API_KEY tanimli degil. Yeni terminal acip tekrar baslatin.'
    });
    return;
  }

  try {
    const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const prompt = String(payload.prompt || '').trim();
      const model = String(payload.model || 'gpt-4o-mini');
      const maxTokens = Number(payload.max_tokens || 600);

      if (!prompt) {
        writeJson(res, 400, { error: 'prompt zorunludur.' });
        return;
      }

      const r = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model,
          input: prompt,
          max_output_tokens: maxTokens,
          temperature: 0.3
        })
      });

      const j = await r.json();
      if (!r.ok) {
        writeJson(res, r.status, {
          error: 'OpenAI hatasi',
          detail: j
        });
        return;
      }

      let text = '';
      if (typeof j.output_text === 'string') {
        text = j.output_text.trim();
      } else if (Array.isArray(j.output)) {
        text = j.output
          .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
          .filter((c) => c && c.type === 'output_text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('\n')
          .trim();
      }

      writeJson(res, 200, {
        text: text || 'Bos analiz dondu. Model yanit uretmedi.'
      });
  } catch (err) {
    writeJson(res, 500, {
      error: 'Proxy islemi basarisiz. OpenAI baglantisini kontrol edin.',
      detail: err.message
    });
  }
}

async function handleBrokerCandles(req, res) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body || '{}');
    const pairId = String(payload.pairId || '').trim().toUpperCase();
    const category = String(payload.category || '').trim().toLowerCase();
    const granularity = String(payload.granularity || 'H1').toUpperCase();
    const count = Math.max(30, Math.min(500, Number(payload.count || 120)));
    const alignmentTimezone = String(payload.alignmentTimezone || 'UTC');
    if (!pairId) {
      writeJson(res, 400, { error: 'pairId zorunludur.' });
      return;
    }
    const pyCode = [
      'import json,sys',
      'import MetaTrader5 as mt5',
      'pair_id=sys.argv[1]',
      'category=sys.argv[2]',
      'gran=sys.argv[3]',
      'count=int(sys.argv[4])',
      'tz=sys.argv[5]',
      'tf_map={"M1":mt5.TIMEFRAME_M1,"M5":mt5.TIMEFRAME_M5,"M15":mt5.TIMEFRAME_M15,"M30":mt5.TIMEFRAME_M30,"H1":mt5.TIMEFRAME_H1,"H4":mt5.TIMEFRAME_H4,"D1":mt5.TIMEFRAME_D1}',
      'timeframe=tf_map.get(gran,mt5.TIMEFRAME_H1)',
      'if not mt5.initialize():',
      '  print(json.dumps({"error":"MT5 initialize basarisiz","detail":str(mt5.last_error())}), flush=True)',
      '  raise SystemExit(1)',
      'base=pair_id.replace("/","").replace("_","").upper()',
      'symbols=mt5.symbols_get() or []',
      'names=[s.name for s in symbols]',
      'def score(n):',
      '  u=n.upper()',
      '  clean="".join(ch for ch in u if ch.isalnum())',
      '  if clean==base: return 100',
      '  if clean.startswith(base): return 90',
      '  if base in clean: return 80',
      '  if category=="indices" and base=="NAS100" and ("NAS" in clean or "USTEC" in clean): return 70',
      '  if category=="indices" and base=="US500" and ("SPX" in clean or "US500" in clean): return 70',
      '  if category=="indices" and base=="US30" and ("US30" in clean or "DJI" in clean): return 70',
      '  return -1',
      'cands=sorted(((score(n),n) for n in names), reverse=True)',
      'symbol=next((n for s,n in cands if s>=70), None)',
      'if not symbol:',
      '  print(json.dumps({"error":"Symbol bulunamadi","pairId":pair_id}), flush=True)',
      '  mt5.shutdown()',
      '  raise SystemExit(2)',
      'if not mt5.symbol_select(symbol, True):',
      '  print(json.dumps({"error":"Symbol secilemedi","symbol":symbol}), flush=True)',
      '  mt5.shutdown()',
      '  raise SystemExit(3)',
      'rates=mt5.copy_rates_from_pos(symbol,timeframe,0,count)',
      'if rates is None or len(rates)==0:',
      '  print(json.dumps({"error":"Mum verisi yok","symbol":symbol,"detail":str(mt5.last_error())}), flush=True)',
      '  mt5.shutdown()',
      '  raise SystemExit(4)',
      'candles=[{"t":int(r["time"]),"o":float(r["open"]),"h":float(r["high"]),"l":float(r["low"]),"c":float(r["close"])} for r in rates]',
      'mt5.shutdown()',
      'print(json.dumps({"provider":"mt5","env":"demo","instrument":symbol,"granularity":gran,"timezone":tz,"candles":candles}), flush=True)'
    ].join('\n');
    const { stdout } = await execFileAsync('py', ['-c', pyCode, pairId, category, granularity, String(count), alignmentTimezone], {
      timeout: 15000,
      maxBuffer: 1024 * 1024
    });
    const j = JSON.parse((stdout || '').trim() || '{}');
    if (j.error) {
      writeJson(res, 502, j);
      return;
    }
    const candles = Array.isArray(j.candles) ? j.candles : [];
    writeJson(res, 200, {
      provider: 'mt5',
      env: 'demo',
      instrument: j.instrument || pairId,
      granularity,
      timezone: alignmentTimezone,
      candles
    });
  } catch (err) {
    writeJson(res, 500, {
      error: 'Broker mum verisi alinmadi.',
      detail: err.message
    });
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    writeJson(res, 204, {});
    return;
  }

  if (req.url === '/api/crt-analyze' && req.method === 'POST') {
    handleAnalyze(req, res);
    return;
  }
  if (req.url === '/api/broker-candles' && req.method === 'POST') {
    handleBrokerCandles(req, res);
    return;
  }

  writeJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`CRT AI proxy calisiyor: http://127.0.0.1:${PORT}`);
});
