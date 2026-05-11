const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 8787);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_URL = process.env.OPENAI_URL || 'https://api.openai.com/v1/responses';
const DB_PATH = process.env.CRT_DB_PATH || 'C:/Users/nihat/Projects/crt-scanner/data/trade_log.db';
const KNOWLEDGE_DIR = process.env.CRT_KNOWLEDGE_DIR || 'C:/Users/nihat/Projects/crt-scanner/knowledge';
const ALLOW_REAL_TRADING = String(process.env.ALLOW_REAL_TRADING || 'false').toLowerCase() === 'true';
const OANDA_API_KEY = process.env.OANDA_API_KEY;
const OANDA_ENV = (process.env.OANDA_ENV || 'practice').toLowerCase();
const OANDA_BASE_URL = OANDA_ENV === 'live'
  ? 'https://api-fxtrade.oanda.com/v3'
  : 'https://api-fxpractice.oanda.com/v3';
const DEBUG_ENABLED = String(process.env.CRT_DEBUG_LOG || 'true').toLowerCase() === 'true';
const DEBUG_LOG_PATH = process.env.CRT_DEBUG_LOG_PATH || 'C:/Users/nihat/Projects/crt-scanner/data/debug.log';

function ensureDebugDir() {
  const dir = path.dirname(DEBUG_LOG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const LOG_ROTATE_MAX_BYTES = Number(process.env.CRT_DEBUG_LOG_MAX_BYTES || 5 * 1024 * 1024);
const LOG_ROTATE_KEEP = Number(process.env.CRT_DEBUG_LOG_KEEP || 3);
let lastRotateCheck = 0;
function maybeRotateDebugLog() {
  const now = Date.now();
  if (now - lastRotateCheck < 5000) return;
  lastRotateCheck = now;
  try {
    if (!fs.existsSync(DEBUG_LOG_PATH)) return;
    const st = fs.statSync(DEBUG_LOG_PATH);
    if (st.size < LOG_ROTATE_MAX_BYTES) return;
    for (let i = LOG_ROTATE_KEEP; i >= 1; i--) {
      const cur = `${DEBUG_LOG_PATH}.${i}`;
      const nxt = `${DEBUG_LOG_PATH}.${i + 1}`;
      if (fs.existsSync(cur)) {
        if (i === LOG_ROTATE_KEEP) {
          try { fs.unlinkSync(cur); } catch (_) {}
        } else {
          try { fs.renameSync(cur, nxt); } catch (_) {}
        }
      }
    }
    try { fs.renameSync(DEBUG_LOG_PATH, `${DEBUG_LOG_PATH}.1`); } catch (_) {}
    fs.writeFileSync(DEBUG_LOG_PATH, `${JSON.stringify({ ts: new Date().toISOString(), level: 'info', event: 'log.rotated', max_bytes: LOG_ROTATE_MAX_BYTES, keep: LOG_ROTATE_KEEP })}\n`, 'utf8');
  } catch (_e) {
    // ignore rotation errors to avoid breaking runtime
  }
}

function logEvent(level, event, detail = {}) {
  if (!DEBUG_ENABLED) return;
  try {
    ensureDebugDir();
    maybeRotateDebugLog();
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...detail
    });
    fs.appendFileSync(DEBUG_LOG_PATH, `${line}\n`, 'utf8');
  } catch (_err) {
    // ignore logging failures to avoid breaking runtime
  }
}

function tailLines(filePath, limit) {
  if (!fs.existsSync(filePath)) return [];
  const txt = fs.readFileSync(filePath, 'utf8');
  const lines = txt.split(/\r?\n/).filter(Boolean);
  return lines.slice(-limit);
}

function getKnowledgeIndex() {
  try {
    if (!fs.existsSync(KNOWLEDGE_DIR)) return [];
    const files = fs.readdirSync(KNOWLEDGE_DIR, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.pdf'))
      .map((d) => {
        const full = path.join(KNOWLEDGE_DIR, d.name);
        const st = fs.statSync(full);
        return {
          name: d.name,
          size_bytes: Number(st.size || 0),
          updated_at: st.mtime.toISOString()
        };
      })
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return files;
  } catch (_e) {
    return [];
  }
}

function writeJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

function pyExec(code, args = []) {
  return execFileAsync('py', ['-c', code, ...args], {
    timeout: 30000,
    maxBuffer: 1024 * 1024
  });
}

function pyExecStdin(code, stdinPayload = '', timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = execFile('py', ['-c', code], {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout, stderr });
    });
    try {
      child.stdin.setDefaultEncoding('utf8');
      child.stdin.write(String(stdinPayload || ''));
      child.stdin.end();
    } catch (e) {
      reject(e);
    }
  });
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
  const startedAt = Date.now();
  if (!OPENAI_API_KEY) {
    logEvent('error', 'analyze.missing_openai_key');
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
        logEvent('warn', 'analyze.invalid_prompt');
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
        logEvent('error', 'analyze.openai_error', { status: r.status });
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
      logEvent('info', 'analyze.ok', { elapsed_ms: Date.now() - startedAt, model });
  } catch (err) {
    logEvent('error', 'analyze.failed', { detail: err.message, elapsed_ms: Date.now() - startedAt });
    writeJson(res, 500, {
      error: 'Proxy islemi basarisiz. OpenAI baglantisini kontrol edin.',
      detail: err.message
    });
  }
}

async function handleBrokerCandles(req, res) {
  const startedAt = Date.now();
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body || '{}');
    const pairId = String(payload.pairId || '').trim().toUpperCase();
    const category = String(payload.category || '').trim().toLowerCase();
    const granularity = String(payload.granularity || 'H1').toUpperCase();
    const count = Math.max(30, Math.min(500, Number(payload.count || 120)));
    const alignmentTimezone = String(payload.alignmentTimezone || 'UTC');
    if (!pairId) {
      logEvent('warn', 'broker_candles.missing_pair');
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
      'symbols=mt5.symbols_get() or []',
      'names=[s.name for s in symbols]',
      'names_ci={n.upper():n for n in names}',
      '# 1) Tam isim (case-insensitive) — frontend genelde brokerin tam sembol adini gonderir',
      'symbol=names_ci.get(pair_id.upper().strip())',
      'if not symbol:',
      '  # 2) Skor bazli fuzzy match — alphanumeric normalize ile broker suffix (.x .r .m) goz ardi',
      '  base="".join(ch for ch in pair_id.upper() if ch.isalnum())',
      '  def score(n):',
      '    u=n.upper()',
      '    clean="".join(ch for ch in u if ch.isalnum())',
      '    if clean==base: return 100',
      '    if clean.startswith(base): return 90',
      '    if base in clean: return 80',
      '    if category=="indices" and base=="NAS100" and ("NAS" in clean or "USTEC" in clean): return 70',
      '    if category=="indices" and base=="US500" and ("SPX" in clean or "US500" in clean): return 70',
      '    if category=="indices" and base=="US30" and ("US30" in clean or "DJI" in clean): return 70',
      '    return -1',
      '  cands=sorted(((score(n),n) for n in names), reverse=True)',
      '  symbol=next((n for s,n in cands if s>=70), None)',
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
      'candles=[{"t":int(r["time"]),"o":float(r["open"]),"h":float(r["high"]),"l":float(r["low"]),"c":float(r["close"]),"v":int(r["tick_volume"]) if "tick_volume" in rates.dtype.names else 0} for r in rates]',
      'mt5.shutdown()',
      'print(json.dumps({"provider":"mt5","env":"demo","instrument":symbol,"granularity":gran,"timezone":tz,"candles":candles}), flush=True)'
    ].join('\n');
    const { stdout } = await execFileAsync('py', ['-c', pyCode, pairId, category, granularity, String(count), alignmentTimezone], {
      timeout: 15000,
      maxBuffer: 1024 * 1024
    });
    const j = JSON.parse((stdout || '').trim() || '{}');
    if (j.error) {
      logEvent('error', 'broker_candles.upstream_error', { pairId, granularity, detail: j.error });
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
    logEvent('info', 'broker_candles.ok', { pairId, granularity, candles: candles.length, elapsed_ms: Date.now() - startedAt });
  } catch (err) {
    logEvent('error', 'broker_candles.failed', { detail: err.message, elapsed_ms: Date.now() - startedAt });
    writeJson(res, 500, {
      error: 'Broker mum verisi alinmadi.',
      detail: err.message
    });
  }
}

async function handleClosePosition(req, res) {
  const startedAt = Date.now();
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body || '{}');
    const ticket = Number(payload.ticket || 0);
    if (!ticket) {
      writeJson(res, 400, { ok: false, error: 'ticket_required' });
      return;
    }
    const pyCode = [
      'import json, sys',
      'import MetaTrader5 as mt5',
      'raw = sys.stdin.read()',
      'p = json.loads(raw or "{}")',
      'ticket = int(p.get("ticket",0) or 0)',
      'if not mt5.initialize():',
      '  print(json.dumps({"ok":False,"error":"mt5_initialize_failed","detail":str(mt5.last_error())}), flush=True)',
      '  raise SystemExit(0)',
      'pos_list = mt5.positions_get(ticket=ticket) or []',
      'if not pos_list:',
      '  mt5.shutdown()',
      '  print(json.dumps({"ok":False,"error":"position_not_found","ticket":ticket}), flush=True)',
      '  raise SystemExit(0)',
      'pos = pos_list[0]',
      'symbol = str(getattr(pos,"symbol","") or "")',
      'volume = float(getattr(pos,"volume",0) or 0)',
      'side_buy = int(getattr(pos,"type",-1)) == mt5.POSITION_TYPE_BUY',
      'tick = mt5.symbol_info_tick(symbol)',
      'if tick is None:',
      '  mt5.shutdown()',
      '  print(json.dumps({"ok":False,"error":"tick_unavailable","ticket":ticket,"symbol":symbol}), flush=True)',
      '  raise SystemExit(0)',
      'price = float(tick.bid) if side_buy else float(tick.ask)',
      'order_type = mt5.ORDER_TYPE_SELL if side_buy else mt5.ORDER_TYPE_BUY',
      'req = {',
      '  "action": mt5.TRADE_ACTION_DEAL,',
      '  "position": ticket,',
      '  "symbol": symbol,',
      '  "volume": volume,',
      '  "type": order_type,',
      '  "price": price,',
      '  "deviation": 30,',
      '  "magic": 990011,',
      '  "comment": "manual_close",',
      '  "type_time": mt5.ORDER_TIME_GTC,',
      '  "type_filling": mt5.ORDER_FILLING_IOC',
      '}',
      'result = mt5.order_send(req)',
      'rc = int(getattr(result,"retcode",0) or 0)',
      'ok = rc in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED)',
      'out = {"ok":ok,"ticket":ticket,"symbol":symbol,"retcode":rc,"detail":str(getattr(result,"comment","") or "")}',
      'mt5.shutdown()',
      'print(json.dumps(out), flush=True)'
    ].join('\n');
    const { stdout } = await pyExecStdin(pyCode, JSON.stringify({ ticket }));
    const j = JSON.parse((stdout || '').trim() || '{}');
    logEvent(j.ok ? 'info' : 'warn', 'close_position.result', {
      ok: !!j.ok, ticket, retcode: j.retcode || 0, elapsed_ms: Date.now() - startedAt
    });
    writeJson(res, j.ok ? 200 : 400, j);
  } catch (err) {
    logEvent('error', 'close_position.failed', { detail: err.message });
    writeJson(res, 500, { ok: false, error: 'close_position_failed', detail: err.message });
  }
}

async function handleCancelPending(req, res) {
  const startedAt = Date.now();
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body || '{}');
    const ticket = Number(payload.ticket || 0);
    if (!ticket) {
      writeJson(res, 400, { ok: false, error: 'ticket_required' });
      return;
    }
    const pyCode = [
      'import json, sys',
      'import MetaTrader5 as mt5',
      'raw = sys.stdin.read()',
      'p = json.loads(raw or "{}")',
      'ticket = int(p.get("ticket",0) or 0)',
      'if not mt5.initialize():',
      '  print(json.dumps({"ok":False,"error":"mt5_initialize_failed","detail":str(mt5.last_error())}), flush=True)',
      '  raise SystemExit(0)',
      'orders = mt5.orders_get(ticket=ticket) or []',
      'if not orders:',
      '  mt5.shutdown()',
      '  print(json.dumps({"ok":False,"error":"order_not_found","ticket":ticket}), flush=True)',
      '  raise SystemExit(0)',
      'req = {"action": mt5.TRADE_ACTION_REMOVE, "order": ticket}',
      'result = mt5.order_send(req)',
      'ok = bool(result and result.retcode in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED))',
      'out = {"ok":ok, "ticket":ticket, "retcode":int(getattr(result,"retcode",0) or 0), "detail":str(getattr(result,"comment","") or "")}',
      'mt5.shutdown()',
      'print(json.dumps(out), flush=True)'
    ].join('\n');
    const { stdout } = await pyExecStdin(pyCode, JSON.stringify({ ticket }));
    const j = JSON.parse((stdout || '').trim() || '{}');
    logEvent(j.ok ? 'info' : 'warn', 'cancel_pending.result', {
      ok: !!j.ok, ticket, retcode: j.retcode || 0, elapsed_ms: Date.now() - startedAt
    });
    writeJson(res, j.ok ? 200 : 400, j);
  } catch (err) {
    logEvent('error', 'cancel_pending.failed', { detail: err.message });
    writeJson(res, 500, { ok: false, error: 'cancel_pending_failed', detail: err.message });
  }
}

async function handleListAllSymbols(_req, res) {
  const startedAt = Date.now();
  try {
    const pyCode = [
      'import json',
      'import MetaTrader5 as mt5',
      'if not mt5.initialize():',
      '  print(json.dumps({"ok":False,"error":"mt5_initialize_failed","detail":str(mt5.last_error())}), flush=True)',
      '  raise SystemExit(0)',
      'syms=mt5.symbols_get() or []',
      'FULL_TRADE = 4  # SYMBOL_TRADE_MODE_FULL',
      'LONG_ONLY = 2',
      'SHORT_ONLY = 3',
      'ALLOWED_MODES = {FULL_TRADE, LONG_ONLY, SHORT_ONLY}',
      'def derive_category(path, name, descr):',
      '  p=(path or "").lower()',
      '  n=(name or "").upper()',
      '  d=(descr or "").lower()',
      '  # Broker suffix temizle (.x .r .pro .raw .m vb.)',
      '  base=n.lstrip("#$")',
      '  for suf in (".X",".R",".PRO",".RAW",".M",".I",".CASH",".SPOT","_X","_R"):',
      '    if base.endswith(suf):',
      '      base=base[:-len(suf)]',
      '  # Sentetik urunler (broker icinden uretilmis varyantlar — XAUEUR, GAUTRY, GAUUSD vb.)',
      '  # bunlari ayri kategoriye al, tarama dahil etme',
      '  if "synthetic" in p: return "synthetic"',
      '  # Path tabanli kontroller (en guvenilir kategorizasyon)',
      '  if "crypto" in p: return "crypto"',
      '  if "metal" in p: return "metals"',
      '  if "indice" in p or "index" in p or "indic" in p: return "indices"',
      '  if "energ" in p: return "energies"',
      '  if "share" in p or "stock" in p or "equit" in p: return "stocks"',
      '  if "bond" in p: return "bonds"',
      '  if "agri" in p or "commod" in p or "soft" in p: return "commodities"',
      '  if "forex" in p or "fx" in p or "currenc" in p: return "forex"',
      '  # Description tabanli',
      '  if "index" in d or "indices" in d: return "indices"',
      '  if "crypto" in d or "cryptocurrency" in d: return "crypto"',
      '  if "oil" in d or "crude" in d or "natural gas" in d: return "energies"',
      '  # Symbol kalibi tabanli (son care)',
      '  index_names={"NAS100","NASDAQ","US500","SP500","SPX","SPX500","US30","DJ30","DJIA","DJI","UK100","FTSE","FTSE100","GER30","GER40","DAX","CAC40","CAC","FRA40","JPN225","N225","NIKKEI","SPA35","IBEX","AUS200","HK50","HSI","RUSSELL","RUSSEL2000","RUSSELL2000","NDX","DXY","USDX"}',
      '  if base in index_names: return "indices"',
      '  if base.startswith(("XAU","XAG","XPT","XPD")): return "metals"',
      '  crypto_tags=("BTC","ETH","XRP","LTC","DOGE","ADA","SOL","DOT","BNB","AVAX","LINK","MATIC","SHIB","TRX","UNI","XLM","ATOM","BCH","BSV","AVE")',
      '  if any(base.startswith(t) for t in crypto_tags): return "crypto"',
      '  energy_tags=("WTI","BRENT","XBR","XTI","NGAS")',
      '  if any(t in base for t in energy_tags) or base in ("NG","OIL"): return "energies"',
      '  commod_tags=("WHEAT","CORN","SOYB","COCOA","COFFEE","SUGAR","COTTON","RICE")',
      '  if any(t in base for t in commod_tags): return "commodities"',
      '  # # veya $ prefix kalan stocks',
      '  if name.startswith(("#","$")): return "stocks"',
      '  # Stocks ipuclari (company/inc/ltd vs)',
      '  if "company" in d or "corporation" in d or "inc." in d or " ltd" in d or " plc" in d:',
      '    return "stocks"',
      '  # Forex: 6 harfli alpha (basit kural)',
      '  clean_base="".join(ch for ch in base if ch.isalpha())',
      '  if len(clean_base)==6:',
      '    return "forex"',
      '  return "other"',
      'rows=[]',
      'for s in syms:',
      '  try:',
      '    name=str(getattr(s,"name","") or "")',
      '    if not name: continue',
      '    info=mt5.symbol_info(name)',
      '    if info is None: continue',
      '    trade_mode=int(getattr(info,"trade_mode",0) or 0)',
      '    if trade_mode not in ALLOWED_MODES: continue',
      '    path=str(getattr(info,"path","") or "")',
      '    descr=str(getattr(info,"description","") or "")',
      '    cat=derive_category(path, name, descr)',
      '    # Brokerin kendi hesabini sor: 1 lot ALIS icin marjin (account currency cinsinden, USD)',
      '    mpl=0.0',
      '    try:',
      '      tick=mt5.symbol_info_tick(name)',
      '      ask=float(getattr(tick,"ask",0) or 0) if tick else 0.0',
      '      if ask>0:',
      '        if not mt5.symbol_select(name, True): pass',
      '        m=mt5.order_calc_margin(mt5.ORDER_TYPE_BUY, name, 1.0, ask)',
      '        if m is not None and m>0: mpl=float(m)',
      '    except Exception:',
      '      mpl=0.0',
      '    rows.append({',
      '      "name": name,',
      '      "category": cat,',
      '      "path": path,',
      '      "description": descr,',
      '      "digits": int(getattr(info,"digits",5) or 5),',
      '      "point": float(getattr(info,"point",0.00001) or 0.00001),',
      '      "volume_min": float(getattr(info,"volume_min",0.01) or 0.01),',
      '      "volume_step": float(getattr(info,"volume_step",0.01) or 0.01),',
      '      "trade_mode": trade_mode,',
      '      "spread": int(getattr(info,"spread",0) or 0),',
      '      "tick_value": float(getattr(info,"trade_tick_value",0) or 0),',
      '      "tick_size": float(getattr(info,"trade_tick_size",0) or 0),',
      '      "stops_level": int(getattr(info,"trade_stops_level",0) or 0),',
      '      "contract_size": float(getattr(info,"trade_contract_size",100000) or 100000),',
      '      "margin_per_lot": mpl,',
      '      "currency_base": str(getattr(info,"currency_base","") or ""),',
      '      "currency_profit": str(getattr(info,"currency_profit","") or ""),',
      '      "currency_margin": str(getattr(info,"currency_margin","") or "")',
      '    })',
      '  except Exception as e:',
      '    continue',
      'rows.sort(key=lambda x: (x["category"], x["name"]))',
      'mt5.shutdown()',
      'print(json.dumps({"ok":True,"count":len(rows),"symbols":rows}, ensure_ascii=False), flush=True)'
    ].join('\n');
    const { stdout } = await pyExec(pyCode, []);
    const j = JSON.parse((stdout || '').trim() || '{}');
    writeJson(res, 200, j);
    logEvent('info', 'list_all_symbols.ok', {
      count: Number(j.count || 0),
      elapsed_ms: Date.now() - startedAt
    });
  } catch (err) {
    logEvent('error', 'list_all_symbols.failed', { detail: err.message, elapsed_ms: Date.now() - startedAt });
    writeJson(res, 500, { ok: false, error: 'list_all_symbols_failed', detail: err.message });
  }
}

async function handleAvailablePairs(req, res) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body || '{}');
    const pairs = Array.isArray(payload.pairs) ? payload.pairs : [];
    const pyCode = [
      'import json,sys',
      'import MetaTrader5 as mt5',
      'p=json.loads(sys.argv[1])',
      'pairs=p.get("pairs",[]) if isinstance(p,dict) else []',
      'if not mt5.initialize():',
      '  print(json.dumps({"ok":False,"error":"mt5_initialize_failed","detail":str(mt5.last_error())}), flush=True)',
      '  raise SystemExit(0)',
      'symbols=mt5.symbols_get() or []',
      'names=[s.name for s in symbols]',
      'def score(base,category,n):',
      '  u=n.upper()',
      '  clean="".join(ch for ch in u if ch.isalnum())',
      '  if clean==base: return 100',
      '  if clean.startswith(base): return 90',
      '  if base in clean: return 80',
      '  if category=="indices" and base=="NAS100" and ("NAS" in clean or "USTEC" in clean): return 70',
      '  if category=="indices" and base=="US500" and ("SPX" in clean or "US500" in clean): return 70',
      '  if category=="indices" and base=="US30" and ("US30" in clean or "DJI" in clean): return 70',
      '  return -1',
      'available=[]',
      'unavailable=[]',
      'names_ci={n.upper():n for n in names}',
      'for row in pairs:',
      '  pid=str((row or {}).get("pairId","") or "").upper().strip()',
      '  cat=str((row or {}).get("category","") or "").lower().strip()',
      '  if not pid:',
      '    continue',
      '  # 1) Once tam isim (case-insensitive) — frontend genelde brokerin tam sembol adini gonderir',
      '  symbol=names_ci.get(pid)',
      '  if not symbol:',
      '    # 2) Skor bazli fuzzy match — alphanumeric normalize ederek (.x .r gibi suffixleri es gec)',
      '    base="".join(ch for ch in pid if ch.isalnum())',
      '    cands=sorted(((score(base,cat,n),n) for n in names), reverse=True)',
      '    symbol=next((n for s,n in cands if s>=70), None)',
      '  if symbol:',
      '    available.append({"pairId":pid,"category":cat,"symbol":symbol})',
      '  else:',
      '    unavailable.append({"pairId":pid,"category":cat})',
      'mt5.shutdown()',
      'print(json.dumps({"ok":True,"available":available,"unavailable":unavailable}, ensure_ascii=False), flush=True)'
    ].join('\n');
    const { stdout } = await pyExec(pyCode, [JSON.stringify({ pairs })]);
    const j = JSON.parse((stdout || '').trim() || '{}');
    writeJson(res, 200, j);
  } catch (err) {
    writeJson(res, 500, { ok: false, error: 'available_pairs_failed', detail: err.message });
  }
}

async function handleHealth(_req, res) {
  const startedAt = Date.now();
  try {
    const pyCode = [
      'import json',
      'import MetaTrader5 as mt5',
      'ok = mt5.initialize()',
      'last = mt5.last_error()',
      'if ok:',
      '  ti = mt5.terminal_info()',
      '  ai = mt5.account_info()',
      '  mode = int(getattr(ai, "trade_mode", -1)) if ai else -1',
      '  mode_name = "demo" if mode == 0 else ("real" if mode == 2 else "unknown")',
      '  out = {"mt5_ok": True, "terminal_connected": bool(getattr(ti, "connected", False)), "account": getattr(ai, "login", None), "trade_mode": mode_name}',
      '  mt5.shutdown()',
      'else:',
      '  out = {"mt5_ok": False, "detail": str(last)}',
      'print(json.dumps(out), flush=True)'
    ].join('\n');
    const { stdout } = await pyExec(pyCode);
    const j = JSON.parse((stdout || '').trim() || '{}');
    writeJson(res, 200, {
      ok: true,
      openai_key_present: !!OPENAI_API_KEY,
      ...j
    });
    logEvent('info', 'health.ok', { mt5_ok: !!j.mt5_ok, terminal_connected: !!j.terminal_connected, elapsed_ms: Date.now() - startedAt });
  } catch (err) {
    logEvent('error', 'health.failed', { detail: err.message, elapsed_ms: Date.now() - startedAt });
    writeJson(res, 500, { ok: false, error: 'Health check failed', detail: err.message });
  }
}

async function handleTradeSnapshot(_req, res) {
  const startedAt = Date.now();
  try {
    const pyCode = [
      'import json, datetime',
      'import MetaTrader5 as mt5',
      'if not mt5.initialize():',
      '  print(json.dumps({"ok": False, "error":"mt5_initialize_failed", "detail": str(mt5.last_error())}), flush=True)',
      '  raise SystemExit(0)',
      'now = datetime.datetime.now(datetime.timezone.utc)',
      'from_dt = now - datetime.timedelta(days=7)',
      'open_positions = mt5.positions_get() or []',
      'open_rows = []',
      'for p in open_positions:',
      '  side = "LONG" if int(getattr(p, "type", -1)) == mt5.POSITION_TYPE_BUY else "SHORT"',
      '  comment = str(getattr(p, "comment", "") or "")',
      '  lc = comment.lower()',
      '  strategy_tag = "core"',
      '  if "turtle" in lc: strategy_tag = "turtle_sopa"',
      '  elif "vwap" in lc: strategy_tag = "vwap_reclaim"',
      '  elif "sr_break" in lc or "sr-" in lc: strategy_tag = "sr_breakout"',
      '  open_rows.append({"ticket": int(getattr(p, "ticket", 0) or 0), "symbol": str(getattr(p, "symbol", "") or ""), "side": side, "volume": float(getattr(p, "volume", 0) or 0), "price_open": float(getattr(p, "price_open", 0) or 0), "sl": float(getattr(p, "sl", 0) or 0), "tp": float(getattr(p, "tp", 0) or 0), "profit": float(getattr(p, "profit", 0) or 0), "time": int(getattr(p, "time", 0) or 0), "comment": comment, "strategy_tag": strategy_tag})',
      'deals = mt5.history_deals_get(from_dt, now) or []',
      'closed_rows = []',
      'for d in deals:',
      '  if int(getattr(d, "entry", -1)) != mt5.DEAL_ENTRY_OUT:',
      '    continue',
      '  reason = int(getattr(d, "reason", -1) or -1)',
      '  reason_name = "other"',
      '  if reason == int(getattr(mt5, "DEAL_REASON_TP", -999)):',
      '    reason_name = "tp"',
      '  elif reason == int(getattr(mt5, "DEAL_REASON_SL", -999)):',
      '    reason_name = "sl"',
      '  result = "tp" if reason_name == "tp" else ("stop" if reason_name == "sl" else ("profit" if float(getattr(d, "profit", 0) or 0) >= 0 else "loss"))',
      '  side = "LONG" if int(getattr(d, "type", -1)) == mt5.ORDER_TYPE_SELL else "SHORT"',
      '  comment = str(getattr(d, "comment", "") or "")',
      '  lc = comment.lower()',
      '  strategy_tag = "core"',
      '  if "turtle" in lc: strategy_tag = "turtle_sopa"',
      '  elif "vwap" in lc: strategy_tag = "vwap_reclaim"',
      '  elif "sr_break" in lc or "sr-" in lc: strategy_tag = "sr_breakout"',
      '  closed_rows.append({"deal": int(getattr(d, "ticket", 0) or 0), "position_id": int(getattr(d, "position_id", 0) or 0), "symbol": str(getattr(d, "symbol", "") or ""), "side": side, "volume": float(getattr(d, "volume", 0) or 0), "price": float(getattr(d, "price", 0) or 0), "profit": float(getattr(d, "profit", 0) or 0), "reason": reason_name, "result": result, "time": int(getattr(d, "time", 0) or 0), "comment": comment, "strategy_tag": strategy_tag})',
      'closed_rows = sorted(closed_rows, key=lambda x: x["time"], reverse=True)[:300]',
      '# Pending orders',
      'pending_orders = mt5.orders_get() or []',
      'pending_rows = []',
      'pending_type_map = {',
      '  int(mt5.ORDER_TYPE_BUY_LIMIT):"BUY_LIMIT",',
      '  int(mt5.ORDER_TYPE_SELL_LIMIT):"SELL_LIMIT",',
      '  int(mt5.ORDER_TYPE_BUY_STOP):"BUY_STOP",',
      '  int(mt5.ORDER_TYPE_SELL_STOP):"SELL_STOP",',
      '  int(getattr(mt5,"ORDER_TYPE_BUY_STOP_LIMIT",-1)):"BUY_STOP_LIMIT",',
      '  int(getattr(mt5,"ORDER_TYPE_SELL_STOP_LIMIT",-1)):"SELL_STOP_LIMIT"',
      '}',
      'for o in pending_orders:',
      '  ot = int(getattr(o,"type",-1))',
      '  if ot not in pending_type_map: continue',
      '  comment = str(getattr(o,"comment","") or "")',
      '  lc = comment.lower()',
      '  strategy_tag = "core"',
      '  if "turtle" in lc: strategy_tag = "turtle_sopa"',
      '  elif "vwap" in lc: strategy_tag = "vwap_reclaim"',
      '  elif "sr_break" in lc or "sr-" in lc: strategy_tag = "sr_breakout"',
      '  side = "LONG" if ot in (int(mt5.ORDER_TYPE_BUY_LIMIT), int(mt5.ORDER_TYPE_BUY_STOP)) else "SHORT"',
      '  sym_name = str(getattr(o,"symbol","") or "")',
      '  bid_v = 0.0; ask_v = 0.0',
      '  try:',
      '    tk = mt5.symbol_info_tick(sym_name)',
      '    if tk is not None:',
      '      bid_v = float(getattr(tk,"bid",0) or 0)',
      '      ask_v = float(getattr(tk,"ask",0) or 0)',
      '  except Exception: pass',
      '  pending_rows.append({',
      '    "ticket": int(getattr(o,"ticket",0) or 0),',
      '    "symbol": sym_name,',
      '    "side": side,',
      '    "type": pending_type_map[ot],',
      '    "volume": float(getattr(o,"volume_initial",0) or 0),',
      '    "price_open": float(getattr(o,"price_open",0) or 0),',
      '    "sl": float(getattr(o,"sl",0) or 0),',
      '    "tp": float(getattr(o,"tp",0) or 0),',
      '    "time_setup": int(getattr(o,"time_setup",0) or 0),',
      '    "time_expiration": int(getattr(o,"time_expiration",0) or 0),',
      '    "bid": bid_v,',
      '    "ask": ask_v,',
      '    "comment": comment,',
      '    "strategy_tag": strategy_tag',
      '  })',
      'mt5.shutdown()',
      'print(json.dumps({"ok": True, "open_positions": open_rows, "closed_deals": closed_rows, "pending_orders": pending_rows}), flush=True)'
    ].join('\n');
    const { stdout } = await pyExec(pyCode);
    const j = JSON.parse((stdout || '').trim() || '{}');
    writeJson(res, 200, j);
    logEvent('info', 'trade_snapshot.ok', {
      open_positions: Array.isArray(j.open_positions) ? j.open_positions.length : 0,
      closed_deals: Array.isArray(j.closed_deals) ? j.closed_deals.length : 0,
      elapsed_ms: Date.now() - startedAt
    });
  } catch (err) {
    logEvent('error', 'trade_snapshot.failed', { detail: err.message, elapsed_ms: Date.now() - startedAt });
    writeJson(res, 500, { ok: false, error: 'trade_snapshot_failed', detail: err.message });
  }
}

async function handleManagePositions(req, res) {
  const startedAt = Date.now();
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body || '{}');
    const tp1R = Math.max(0.2, Number(payload.tp1_rr || 1.0));
    const beAtR = Math.max(0.2, Number(payload.be_at_r || 1.0));
    const trailAtR = Math.max(0.2, Number(payload.trail_at_r || 1.5));
    const partialClosePct = Math.max(0, Math.min(100, Number(payload.partial_close_pct || 50)));
    const earlyManageUsd = Math.max(0, Number(payload.early_manage_usd || 0));
    const portfolioTpUsd = Math.max(0, Number(payload.portfolio_tp_usd || 0));
    const portfolioSlUsd = Math.max(0, Number(payload.portfolio_sl_usd || 0));
    const portfolioBeUsd = Math.max(0, Number(payload.portfolio_be_usd || 0));
    const portfolioTrailActivateUsd = Math.max(0, Number(payload.portfolio_trail_activate_usd || 0));
    const portfolioTrailDrawdownUsd = Math.max(0, Number(payload.portfolio_trail_drawdown_usd || 0));
    // Per-category basket configs: {forex:{tp_usd,sl_usd,be_usd,trail_activate_usd,trail_drawdown_usd}, ...}
    // pair_categories: optional symbol -> category map from frontend (saves backend re-derivation cost)
    const categoryBaskets = (payload.category_baskets && typeof payload.category_baskets==='object') ? payload.category_baskets : {};
    const pairCategories = (payload.pair_categories && typeof payload.pair_categories==='object') ? payload.pair_categories : {};
    const pyCode = [
      'import json,sys,sqlite3,os,datetime,math',
      'import MetaTrader5 as mt5',
      'p=json.loads(sys.argv[1])',
      'db_path=sys.argv[2]',
      'os.makedirs(os.path.dirname(db_path), exist_ok=True)',
      'conn=sqlite3.connect(db_path)',
      'cur=conn.cursor()',
      'cur.execute("""CREATE TABLE IF NOT EXISTS manage_state (position_ticket INTEGER PRIMARY KEY, tp1_done INTEGER DEFAULT 0, updated_at TEXT)""")',
      'tp1_r=float(p.get("tp1_rr",1.0) or 1.0)',
      'be_at_r=float(p.get("be_at_r",1.0) or 1.0)',
      'trail_at_r=float(p.get("trail_at_r",1.5) or 1.5)',
      'partial_close_pct=float(p.get("partial_close_pct",50) or 50)',
      'early_manage_usd=float(p.get("early_manage_usd",0) or 0)',
      'portfolio_tp_usd=float(p.get("portfolio_tp_usd",0) or 0)',
      'portfolio_sl_usd=float(p.get("portfolio_sl_usd",0) or 0)',
      'portfolio_be_usd=float(p.get("portfolio_be_usd",0) or 0)',
      'portfolio_trail_activate_usd=float(p.get("portfolio_trail_activate_usd",0) or 0)',
      'portfolio_trail_drawdown_usd=float(p.get("portfolio_trail_drawdown_usd",0) or 0)',
      'cur.execute("""CREATE TABLE IF NOT EXISTS portfolio_state (id INTEGER PRIMARY KEY, peak_profit REAL DEFAULT 0, trail_armed INTEGER DEFAULT 0, updated_at TEXT)""")',
      'if not mt5.initialize():',
      '  out={"ok":False,"error":"mt5_initialize_failed","detail":str(mt5.last_error())}',
      '  conn.close()',
      '  print(json.dumps(out), flush=True)',
      '  raise SystemExit(0)',
      'positions=mt5.positions_get() or []',
      'actions=[]',
      'def adopt_levels(symbol, side, entry, point):',
      '  # SL/TP atanmamis pozisyonu son 96 M15 mumdan CRH/CRL ve ATR ile sahiplen',
      '  bars=mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_M15, 0, 96)',
      '  if bars is None or len(bars)<24:',
      '    return None',
      '  highs=[float(b["high"]) for b in bars]',
      '  lows=[float(b["low"]) for b in bars]',
      '  closes=[float(b["close"]) for b in bars]',
      '  crh=max(highs[-48:])',
      '  crl=min(lows[-48:])',
      '  rng=crh-crl',
      '  if rng<=point*10:',
      '    return None',
      '  # ATR yaklasimi (basit)',
      '  trs=[]',
      '  for i in range(1,len(bars)):',
      '    h=highs[i]; l=lows[i]; pc=closes[i-1]',
      '    trs.append(max(h-l, abs(h-pc), abs(l-pc)))',
      '  atr=sum(trs[-14:])/max(1,len(trs[-14:])) if trs else rng*0.02',
      '  buf=max(atr*0.5, point*30)',
      '  if side=="LONG":',
      '    sl_new=min(crl - buf, entry - atr*1.2)',
      '    risk=entry - sl_new',
      '    if risk<=point*10:',
      '      return None',
      '    tp_new=entry + risk*2.0',
      '  else:',
      '    sl_new=max(crh + buf, entry + atr*1.2)',
      '    risk=sl_new - entry',
      '    if risk<=point*10:',
      '      return None',
      '    tp_new=entry - risk*2.0',
      '  return {"sl":float(sl_new),"tp":float(tp_new),"crh":float(crh),"crl":float(crl),"atr":float(atr)}',
      'for pos in positions:',
      '  ticket=int(getattr(pos,"ticket",0) or 0)',
      '  symbol=str(getattr(pos,"symbol","") or "")',
      '  side="LONG" if int(getattr(pos,"type",-1))==mt5.POSITION_TYPE_BUY else "SHORT"',
      '  volume=float(getattr(pos,"volume",0) or 0)',
      '  entry=float(getattr(pos,"price_open",0) or 0)',
      '  sl=float(getattr(pos,"sl",0) or 0)',
      '  tp=float(getattr(pos,"tp",0) or 0)',
      '  if not symbol or volume<=0:',
      '    continue',
      '  tick=mt5.symbol_info_tick(symbol)',
      '  si=mt5.symbol_info(symbol)',
      '  if tick is None or si is None:',
      '    continue',
      '  point=max(float(getattr(si,"point",0.00001) or 0.00001),0.00001)',
      '  vol_step=float(getattr(si,"volume_step",0.01) or 0.01)',
      '  vol_min=float(getattr(si,"volume_min",0.01) or 0.01)',
      '  px=float(tick.bid if side=="LONG" else tick.ask)',
      '  # SL/TP atanmamissa sahiplen (adoption)',
      '  needs_adoption = (sl<=0) or (tp<=0)',
      '  if needs_adoption:',
      '    lv=adopt_levels(symbol, side, entry, point)',
      '    if lv is not None:',
      '      new_sl = lv["sl"] if sl<=0 else sl',
      '      new_tp = lv["tp"] if tp<=0 else tp',
      '      # Pozisyon zarari geri donulemez seviyede ise sl secimi mantikli mi kontrolu',
      '      if side=="LONG" and new_sl>=px:',
      '        new_sl = px - max(lv["atr"]*0.8, point*30)',
      '      if side=="SHORT" and new_sl<=px:',
      '        new_sl = px + max(lv["atr"]*0.8, point*30)',
      '      req={"action":mt5.TRADE_ACTION_SLTP,"position":ticket,"symbol":symbol,"sl":float(new_sl),"tp":float(new_tp),"magic":20260506,"comment":"crt-adopt"}',
      '      rr=mt5.order_send(req)',
      '      ok=bool(rr and rr.retcode in (mt5.TRADE_RETCODE_DONE,mt5.TRADE_RETCODE_PLACED))',
      '      actions.append({"ticket":ticket,"symbol":symbol,"side":side,"type":"adopt","ok":ok,"retcode":int(getattr(rr,"retcode",0) or 0),"new_sl":float(new_sl),"new_tp":float(new_tp),"crh":float(lv["crh"]),"crl":float(lv["crl"]),"atr":float(lv["atr"]),"detail":"orphan_position_adopted"})',
      '      if ok:',
      '        sl=float(new_sl)',
      '        tp=float(new_tp)',
      '  risk=abs(entry-sl)',
      '  if sl<=0 or risk<=point*2:',
      '    continue',
      '  r=(px-entry)/risk if side=="LONG" else (entry-px)/risk',
      '  profit_usd=float(getattr(pos,"profit",0) or 0)',
      '  # Erken yonetim: profit_usd belirli esigi gecince BE+trailing+TP1 ayni anda devreye girer',
      '  early_hit=(early_manage_usd>0.0 and profit_usd>=early_manage_usd)',
      '  desired_sl=sl',
      '  if r>=be_at_r or early_hit:',
      '    desired_sl=max(desired_sl,entry) if side=="LONG" else (min(desired_sl,entry) if desired_sl>0 else entry)',
      '  if r>=trail_at_r or early_hit:',
      '    trail_dist=risk*0.6',
      '    t_sl=(px-trail_dist) if side=="LONG" else (px+trail_dist)',
      '    desired_sl=max(desired_sl,t_sl) if side=="LONG" else (min(desired_sl,t_sl) if desired_sl>0 else t_sl)',
      '  improve=(desired_sl-sl)>(point*5) if side=="LONG" else ((sl-desired_sl)>(point*5) if sl>0 else True)',
      '  if improve and desired_sl>0:',
      '    req={"action":mt5.TRADE_ACTION_SLTP,"position":ticket,"symbol":symbol,"sl":float(desired_sl),"tp":float(tp),"magic":20260506,"comment":"crt-manage"}',
      '    rr=mt5.order_send(req)',
      '    actions.append({"ticket":ticket,"symbol":symbol,"type":"sl_update","ok":bool(rr and rr.retcode in (mt5.TRADE_RETCODE_DONE,mt5.TRADE_RETCODE_PLACED)),"retcode":int(getattr(rr,"retcode",0) or 0),"new_sl":float(desired_sl)})',
      '  row=cur.execute("SELECT tp1_done FROM manage_state WHERE position_ticket=?",(ticket,)).fetchone()',
      '  tp1_done=int(row[0]) if row else 0',
      '  if (r>=tp1_r or early_hit) and tp1_done==0 and partial_close_pct>0:',
      '    close_vol=max(vol_min, math.floor((volume*(partial_close_pct/100.0))/vol_step)*vol_step)',
      '    if close_vol>=vol_min and close_vol<volume:',
      '      close_type=mt5.ORDER_TYPE_SELL if side=="LONG" else mt5.ORDER_TYPE_BUY',
      '      close_price=float(tick.bid if close_type==mt5.ORDER_TYPE_SELL else tick.ask)',
      '      req={"action":mt5.TRADE_ACTION_DEAL,"symbol":symbol,"volume":float(close_vol),"type":close_type,"position":ticket,"price":close_price,"deviation":20,"magic":20260506,"comment":"crt-tp1-partial","type_time":mt5.ORDER_TIME_GTC,"type_filling":mt5.ORDER_FILLING_IOC}',
      '      rr=mt5.order_send(req)',
      '      ok=bool(rr and rr.retcode in (mt5.TRADE_RETCODE_DONE,mt5.TRADE_RETCODE_PLACED))',
      '      actions.append({"ticket":ticket,"symbol":symbol,"type":"tp1_partial_close","ok":ok,"retcode":int(getattr(rr,"retcode",0) or 0),"closed_volume":float(close_vol)})',
      '      if ok:',
      '        cur.execute("INSERT INTO manage_state(position_ticket,tp1_done,updated_at) VALUES(?,?,?) ON CONFLICT(position_ticket) DO UPDATE SET tp1_done=excluded.tp1_done, updated_at=excluded.updated_at",(ticket,1,datetime.datetime.utcnow().isoformat()))',
      '  cur.execute("INSERT INTO manage_state(position_ticket,tp1_done,updated_at) VALUES(?,?,?) ON CONFLICT(position_ticket) DO UPDATE SET updated_at=excluded.updated_at",(ticket,tp1_done,datetime.datetime.utcnow().isoformat()))',
      '# === PORTFOLIO LEVEL BASKET TP/SL/BE — GLOBAL + PER-CATEGORY ===',
      'cur.execute("""CREATE TABLE IF NOT EXISTS category_portfolio_state (category TEXT PRIMARY KEY, peak_profit REAL DEFAULT 0, trail_armed INTEGER DEFAULT 0, updated_at TEXT)""")',
      'try:',
      '  fresh_positions=mt5.positions_get() or []',
      'except Exception:',
      '  fresh_positions=positions',
      'category_baskets=p.get("category_baskets",{}) or {}',
      'pair_categories={str(k).upper():str(v).lower() for k,v in (p.get("pair_categories",{}) or {}).items()}',
      'def _derive_cat_py(sym, path):',
      '  s=(sym or "").upper(); pp=(path or "").lower()',
      '  if "crypto" in pp or "bitcoin" in pp or any(t in s for t in ["BTC","ETH","XRP","LTC","DOGE","SOL","ADA","DOT","SHIB"]): return "crypto"',
      '  if "energy" in pp or "energies" in pp or any(t in s for t in ["WTI","BRENT","CRUDE","NATGAS","NGAS","XNG"]): return "energies"',
      '  if "indices" in pp or "indice" in pp or any(t in s for t in ["NAS","SPX","US30","US500","DJI","DAX","FTSE","NIKK","CAC","STOXX","HK50","GER","UK100","JPN"]): return "indices"',
      '  if "metal" in pp or any(t in s for t in ["XAU","XAG","XPT","XPD","GOLD","SILVER"]): return "metals"',
      '  if "bond" in pp or any(t in s for t in ["US10","BUND","TNOTE"]): return "bonds"',
      '  if "commod" in pp or any(t in s for t in ["WHEAT","COCOA","COFFEE","SUGAR","CORN","SOY"]): return "commodities"',
      '  if "stock" in pp or "share" in pp or "equit" in pp: return "stocks"',
      '  return "forex"',
      'def pos_category(pos):',
      '  sym=str(getattr(pos,"symbol","") or "").upper()',
      '  if sym in pair_categories: return pair_categories[sym]',
      '  si2=mt5.symbol_info(sym)',
      '  path=str(getattr(si2,"path","") or "") if si2 else ""',
      '  return _derive_cat_py(sym, path)',
      '# Pozisyonlari kategoriye ayir',
      'positions_by_cat={}',
      'for pp in fresh_positions:',
      '  cat=pos_category(pp)',
      '  positions_by_cat.setdefault(cat,[]).append(pp)',
      '# Enabled kategori basket setleri (en az 1 esik tanimliysa enabled sayilir)',
      'enabled_cats=set()',
      'for c,cfg in category_baskets.items():',
      '  if not cfg: continue',
      '  if any(float(cfg.get(k,0) or 0)>0 for k in ("tp_usd","sl_usd","be_usd","trail_activate_usd")):',
      '    enabled_cats.add(str(c).lower())',
      'category_results={}',
      'portfolio_action=None',
      'threshold_used=0.0',
      '# --- PER-CATEGORY BASKET ---',
      'for cat_key, plist in positions_by_cat.items():',
      '  cat_key_l=str(cat_key).lower()',
      '  if cat_key_l not in enabled_cats: continue',
      '  cfg=category_baskets.get(cat_key_l, {})',
      '  tp_u=float(cfg.get("tp_usd",0) or 0)',
      '  sl_u=float(cfg.get("sl_usd",0) or 0)',
      '  be_u=float(cfg.get("be_usd",0) or 0)',
      '  tra_u=float(cfg.get("trail_activate_usd",0) or 0)',
      '  trd_u=float(cfg.get("trail_drawdown_usd",0) or 0)',
      '  c_total=sum(float(getattr(pp,"profit",0) or 0) for pp in plist)',
      '  c_peak=0.0; c_armed=0',
      '  try:',
      '    rrow=cur.execute("SELECT peak_profit,trail_armed FROM category_portfolio_state WHERE category=?",(cat_key_l,)).fetchone()',
      '    if rrow: c_peak=float(rrow[0] or 0); c_armed=int(rrow[1] or 0)',
      '  except Exception: pass',
      '  if len(plist)==0:',
      '    c_peak=0.0; c_armed=0',
      '  else:',
      '    if c_total>c_peak: c_peak=c_total',
      '    if tra_u>0 and c_total>=tra_u: c_armed=1',
      '  cur.execute("INSERT INTO category_portfolio_state(category,peak_profit,trail_armed,updated_at) VALUES(?,?,?,?) ON CONFLICT(category) DO UPDATE SET peak_profit=excluded.peak_profit, trail_armed=excluded.trail_armed, updated_at=excluded.updated_at",(cat_key_l,float(c_peak),int(c_armed),datetime.datetime.utcnow().isoformat()))',
      '  c_dd=c_peak-c_total',
      '  c_action=None; c_thr=0.0',
      '  if len(plist)>0:',
      '    if c_armed and trd_u>0 and c_dd>=trd_u and c_total>0:',
      '      c_action="trail_basket"; c_thr=c_peak',
      '    elif tp_u>0 and c_total>=tp_u:',
      '      c_action="tp_basket"; c_thr=tp_u',
      '    elif sl_u>0 and c_total<=-sl_u:',
      '      c_action="sl_basket"; c_thr=-sl_u',
      '    elif be_u>0 and c_total>=be_u:',
      '      c_action="be_basket"; c_thr=be_u',
      '  category_results[cat_key_l]={"total_profit":float(c_total),"peak":float(c_peak),"drawdown":float(c_dd),"trail_armed":int(c_armed),"action":c_action,"threshold":float(c_thr),"positions":len(plist)}',
      '  if c_action in ("tp_basket","sl_basket","trail_basket"):',
      '    if c_action=="trail_basket":',
      '      cur.execute("INSERT INTO category_portfolio_state(category,peak_profit,trail_armed,updated_at) VALUES(?,?,?,?) ON CONFLICT(category) DO UPDATE SET peak_profit=excluded.peak_profit, trail_armed=excluded.trail_armed, updated_at=excluded.updated_at",(cat_key_l,0.0,0,datetime.datetime.utcnow().isoformat()))',
      '    for pp in plist:',
      '      ticket=int(getattr(pp,"ticket",0) or 0)',
      '      symbol=str(getattr(pp,"symbol","") or "")',
      '      side="LONG" if int(getattr(pp,"type",-1))==mt5.POSITION_TYPE_BUY else "SHORT"',
      '      volume=float(getattr(pp,"volume",0) or 0)',
      '      pos_profit=float(getattr(pp,"profit",0) or 0)',
      '      if not symbol or volume<=0: continue',
      '      t2=mt5.symbol_info_tick(symbol)',
      '      if t2 is None: continue',
      '      close_type=mt5.ORDER_TYPE_SELL if side=="LONG" else mt5.ORDER_TYPE_BUY',
      '      close_price=float(t2.bid if close_type==mt5.ORDER_TYPE_SELL else t2.ask)',
      '      req={"action":mt5.TRADE_ACTION_DEAL,"symbol":symbol,"volume":float(volume),"type":close_type,"position":ticket,"price":close_price,"deviation":30,"magic":20260506,"comment":f"crt-{c_action}-{cat_key_l}","type_time":mt5.ORDER_TIME_GTC,"type_filling":mt5.ORDER_FILLING_IOC}',
      '      rr=mt5.order_send(req)',
      '      ok=bool(rr and rr.retcode in (mt5.TRADE_RETCODE_DONE,mt5.TRADE_RETCODE_PLACED))',
      '      actions.append({"ticket":ticket,"symbol":symbol,"side":side,"type":c_action,"category":cat_key_l,"ok":ok,"retcode":int(getattr(rr,"retcode",0) or 0),"closed_volume":float(volume),"pos_profit":pos_profit,"total_profit":float(c_total),"threshold":float(c_thr),"peak":float(c_peak),"drawdown":float(c_dd)})',
      '  elif c_action=="be_basket":',
      '    for pp in plist:',
      '      ticket=int(getattr(pp,"ticket",0) or 0)',
      '      symbol=str(getattr(pp,"symbol","") or "")',
      '      side="LONG" if int(getattr(pp,"type",-1))==mt5.POSITION_TYPE_BUY else "SHORT"',
      '      entry=float(getattr(pp,"price_open",0) or 0)',
      '      cur_sl=float(getattr(pp,"sl",0) or 0)',
      '      cur_tp=float(getattr(pp,"tp",0) or 0)',
      '      if not symbol or entry<=0: continue',
      '      si3=mt5.symbol_info(symbol)',
      '      if si3 is None: continue',
      '      point=max(float(getattr(si3,"point",0.00001) or 0.00001),0.00001)',
      '      if side=="LONG" and cur_sl>0 and cur_sl>=(entry-point*2): continue',
      '      if side=="SHORT" and cur_sl>0 and cur_sl<=(entry+point*2): continue',
      '      new_sl=entry',
      '      req={"action":mt5.TRADE_ACTION_SLTP,"position":ticket,"symbol":symbol,"sl":float(new_sl),"tp":float(cur_tp),"magic":20260506,"comment":f"crt-cat-be-{cat_key_l}"}',
      '      rr=mt5.order_send(req)',
      '      ok=bool(rr and rr.retcode in (mt5.TRADE_RETCODE_DONE,mt5.TRADE_RETCODE_PLACED))',
      '      actions.append({"ticket":ticket,"symbol":symbol,"side":side,"type":"category_be","category":cat_key_l,"ok":ok,"retcode":int(getattr(rr,"retcode",0) or 0),"new_sl":float(new_sl),"total_profit":float(c_total),"threshold":float(c_thr)})',
      '# --- GLOBAL BASKET (sadece enabled olmayan kategorilerin pozisyonlari uzerinde) ---',
      'global_positions=[]',
      'for cat_key, plist in positions_by_cat.items():',
      '  if str(cat_key).lower() not in enabled_cats: global_positions.extend(plist)',
      'total_profit=0.0',
      'for pp in global_positions:',
      '  total_profit+=float(getattr(pp,"profit",0) or 0)',
      'peak_profit=0.0; trail_armed=0',
      'try:',
      '  rrow=cur.execute("SELECT peak_profit,trail_armed FROM portfolio_state WHERE id=1").fetchone()',
      '  if rrow: peak_profit=float(rrow[0] or 0); trail_armed=int(rrow[1] or 0)',
      'except Exception: pass',
      'if len(global_positions)==0:',
      '  peak_profit=0.0; trail_armed=0',
      'else:',
      '  if total_profit>peak_profit: peak_profit=total_profit',
      '  if portfolio_trail_activate_usd>0.0 and total_profit>=portfolio_trail_activate_usd: trail_armed=1',
      'cur.execute("INSERT INTO portfolio_state(id,peak_profit,trail_armed,updated_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET peak_profit=excluded.peak_profit, trail_armed=excluded.trail_armed, updated_at=excluded.updated_at",(float(peak_profit),int(trail_armed),datetime.datetime.utcnow().isoformat()))',
      'drawdown=peak_profit-total_profit',
      'if len(global_positions)>0:',
      '  if trail_armed and portfolio_trail_drawdown_usd>0.0 and drawdown>=portfolio_trail_drawdown_usd and total_profit>0:',
      '    portfolio_action="trail_basket"; threshold_used=peak_profit',
      '  elif portfolio_tp_usd>0.0 and total_profit>=portfolio_tp_usd:',
      '    portfolio_action="tp_basket"; threshold_used=portfolio_tp_usd',
      '  elif portfolio_sl_usd>0.0 and total_profit<=-portfolio_sl_usd:',
      '    portfolio_action="sl_basket"; threshold_used=-portfolio_sl_usd',
      '  elif portfolio_be_usd>0.0 and total_profit>=portfolio_be_usd:',
      '    portfolio_action="be_basket"; threshold_used=portfolio_be_usd',
      'if portfolio_action in ("tp_basket","sl_basket","trail_basket"):',
      '  if portfolio_action=="trail_basket":',
      '    cur.execute("INSERT INTO portfolio_state(id,peak_profit,trail_armed,updated_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET peak_profit=excluded.peak_profit, trail_armed=excluded.trail_armed, updated_at=excluded.updated_at",(0.0,0,datetime.datetime.utcnow().isoformat()))',
      '  for pos in global_positions:',
      '    ticket=int(getattr(pos,"ticket",0) or 0)',
      '    symbol=str(getattr(pos,"symbol","") or "")',
      '    side="LONG" if int(getattr(pos,"type",-1))==mt5.POSITION_TYPE_BUY else "SHORT"',
      '    volume=float(getattr(pos,"volume",0) or 0)',
      '    pos_profit=float(getattr(pos,"profit",0) or 0)',
      '    if not symbol or volume<=0: continue',
      '    tick=mt5.symbol_info_tick(symbol)',
      '    if tick is None: continue',
      '    close_type=mt5.ORDER_TYPE_SELL if side=="LONG" else mt5.ORDER_TYPE_BUY',
      '    close_price=float(tick.bid if close_type==mt5.ORDER_TYPE_SELL else tick.ask)',
      '    req={"action":mt5.TRADE_ACTION_DEAL,"symbol":symbol,"volume":float(volume),"type":close_type,"position":ticket,"price":close_price,"deviation":30,"magic":20260506,"comment":f"crt-{portfolio_action}","type_time":mt5.ORDER_TIME_GTC,"type_filling":mt5.ORDER_FILLING_IOC}',
      '    rr=mt5.order_send(req)',
      '    ok=bool(rr and rr.retcode in (mt5.TRADE_RETCODE_DONE,mt5.TRADE_RETCODE_PLACED))',
      '    actions.append({"ticket":ticket,"symbol":symbol,"side":side,"type":portfolio_action,"ok":ok,"retcode":int(getattr(rr,"retcode",0) or 0),"closed_volume":float(volume),"pos_profit":pos_profit,"total_profit":float(total_profit),"threshold":float(threshold_used),"peak":float(peak_profit),"drawdown":float(drawdown)})',
      'elif portfolio_action=="be_basket":',
      '  for pos in global_positions:',
      '    ticket=int(getattr(pos,"ticket",0) or 0)',
      '    symbol=str(getattr(pos,"symbol","") or "")',
      '    side="LONG" if int(getattr(pos,"type",-1))==mt5.POSITION_TYPE_BUY else "SHORT"',
      '    entry=float(getattr(pos,"price_open",0) or 0)',
      '    cur_sl=float(getattr(pos,"sl",0) or 0)',
      '    cur_tp=float(getattr(pos,"tp",0) or 0)',
      '    if not symbol or entry<=0: continue',
      '    si=mt5.symbol_info(symbol)',
      '    if si is None: continue',
      '    point=max(float(getattr(si,"point",0.00001) or 0.00001),0.00001)',
      '    if side=="LONG" and cur_sl>0 and cur_sl>=(entry-point*2): continue',
      '    if side=="SHORT" and cur_sl>0 and cur_sl<=(entry+point*2): continue',
      '    new_sl=entry',
      '    req={"action":mt5.TRADE_ACTION_SLTP,"position":ticket,"symbol":symbol,"sl":float(new_sl),"tp":float(cur_tp),"magic":20260506,"comment":"crt-portfolio-be"}',
      '    rr=mt5.order_send(req)',
      '    ok=bool(rr and rr.retcode in (mt5.TRADE_RETCODE_DONE,mt5.TRADE_RETCODE_PLACED))',
      '    actions.append({"ticket":ticket,"symbol":symbol,"side":side,"type":"portfolio_be","ok":ok,"retcode":int(getattr(rr,"retcode",0) or 0),"new_sl":float(new_sl),"total_profit":float(total_profit),"threshold":float(threshold_used)})',
      '# UI gosterimi icin total_profit gercek toplam (per-cat dahil) olarak override edilir',
      'total_profit_all=sum(float(getattr(pp,"profit",0) or 0) for pp in fresh_positions)',
      'conn.commit()',
      'conn.close()',
      'mt5.shutdown()',
      'print(json.dumps({"ok":True,"managed_count":len(positions),"actions":actions,"total_profit":float(total_profit_all),"global_profit":float(total_profit),"peak_profit":float(peak_profit),"drawdown":float(drawdown),"trail_armed":int(trail_armed),"portfolio_action":portfolio_action,"category_results":category_results,"enabled_categories":sorted(list(enabled_cats))}, ensure_ascii=False), flush=True)'
    ].join('\n');
    const { stdout } = await pyExec(pyCode, [JSON.stringify({ tp1_rr: tp1R, be_at_r: beAtR, trail_at_r: trailAtR, partial_close_pct: partialClosePct, early_manage_usd: earlyManageUsd, portfolio_tp_usd: portfolioTpUsd, portfolio_sl_usd: portfolioSlUsd, portfolio_be_usd: portfolioBeUsd, portfolio_trail_activate_usd: portfolioTrailActivateUsd, portfolio_trail_drawdown_usd: portfolioTrailDrawdownUsd, category_baskets: categoryBaskets, pair_categories: pairCategories }), DB_PATH]);
    const j = JSON.parse((stdout || '').trim() || '{}');
    writeJson(res, 200, j);
    logEvent('info', 'manage_positions.ok', {
      managed_count: Number(j.managed_count || 0),
      actions: Array.isArray(j.actions) ? j.actions.length : 0,
      elapsed_ms: Date.now() - startedAt
    });
  } catch (err) {
    logEvent('error', 'manage_positions.failed', { detail: err.message, elapsed_ms: Date.now() - startedAt });
    writeJson(res, 500, { ok: false, error: 'manage_positions_failed', detail: err.message });
  }
}

// Tum portfoy + kategori trail state'lerini sifirla. Frontend, tum pozisyonlar kapandiginda cagirir.
async function handleResetPortfolioState(req, res) {
  const startedAt = Date.now();
  try {
    const pyCode = [
      'import json,sys,sqlite3,os,datetime',
      'db_path=sys.argv[1]',
      'os.makedirs(os.path.dirname(db_path), exist_ok=True)',
      'conn=sqlite3.connect(db_path)',
      'cur=conn.cursor()',
      'cur.execute("""CREATE TABLE IF NOT EXISTS portfolio_state (id INTEGER PRIMARY KEY, peak_profit REAL DEFAULT 0, trail_armed INTEGER DEFAULT 0, updated_at TEXT)""")',
      'cur.execute("""CREATE TABLE IF NOT EXISTS category_portfolio_state (category TEXT PRIMARY KEY, peak_profit REAL DEFAULT 0, trail_armed INTEGER DEFAULT 0, updated_at TEXT)""")',
      'now=datetime.datetime.utcnow().isoformat()',
      '# Global state sifirla (sticky id=1)',
      'cur.execute("INSERT INTO portfolio_state(id,peak_profit,trail_armed,updated_at) VALUES(1,0,0,?) ON CONFLICT(id) DO UPDATE SET peak_profit=0, trail_armed=0, updated_at=excluded.updated_at",(now,))',
      '# Tum kategori state row\'larini sifirla',
      'rows=cur.execute("SELECT category FROM category_portfolio_state").fetchall()',
      'cats=[r[0] for r in rows] if rows else []',
      'for c in cats:',
      '  cur.execute("UPDATE category_portfolio_state SET peak_profit=0, trail_armed=0, updated_at=? WHERE category=?",(now,c))',
      'conn.commit()',
      'conn.close()',
      'print(json.dumps({"ok":True,"reset_global":True,"reset_categories":cats,"count":len(cats)+1}, ensure_ascii=False), flush=True)'
    ].join('\n');
    const { stdout } = await pyExec(pyCode, [DB_PATH]);
    const j = JSON.parse((stdout || '').trim() || '{}');
    writeJson(res, 200, j);
    logEvent('info', 'reset_portfolio_state.ok', { elapsed_ms: Date.now() - startedAt, reset_count: Number(j.count || 0) });
  } catch (err) {
    logEvent('error', 'reset_portfolio_state.failed', { detail: err.message, elapsed_ms: Date.now() - startedAt });
    writeJson(res, 500, { ok: false, error: 'reset_portfolio_state_failed', detail: err.message });
  }
}

async function handleExecuteOrder(req, res) {
  const startedAt = Date.now();
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body || '{}');
    const targetAccountType = String(payload.target_account_type || '').trim().toLowerCase();
    if (!['demo', 'live'].includes(targetAccountType)) {
      logEvent('warn', 'execute_order.invalid_target_account_type', { targetAccountType });
      writeJson(res, 400, {
        ok: false,
        error: 'invalid_target_account_type',
        detail: 'target_account_type demo veya live olmalidir.'
      });
      return;
    }
    if (targetAccountType === 'live' && !ALLOW_REAL_TRADING) {
      logEvent('warn', 'execute_order.live_blocked');
      writeJson(res, 403, {
        ok: false,
        error: 'live_trading_blocked',
        detail: 'Live emirler kapali. ALLOW_REAL_TRADING=true ile acin.'
      });
      return;
    }
    const pyCode = [
      'import json,sys,sqlite3,os,datetime',
      'import MetaTrader5 as mt5',
      'p=json.loads(sys.argv[1])',
      'db_path=sys.argv[2]',
      'os.makedirs(os.path.dirname(db_path), exist_ok=True)',
      'conn=sqlite3.connect(db_path)',
      'cur=conn.cursor()',
      'cur.execute("""CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, symbol TEXT, side TEXT, lot REAL, entry REAL, sl REAL, tp REAL, dry_run INTEGER, status TEXT, detail TEXT, target_account_type TEXT, strategy_tag TEXT)""")',
      'cols=[r[1] for r in cur.execute("PRAGMA table_info(orders)").fetchall()]',
      'if "target_account_type" not in cols:',
      '  cur.execute("ALTER TABLE orders ADD COLUMN target_account_type TEXT")',
      'if "strategy_tag" not in cols:',
      '  cur.execute("ALTER TABLE orders ADD COLUMN strategy_tag TEXT")',
      'symbol=str(p.get("symbol","")).strip()',
      'side=str(p.get("side","")).upper()',
      'lot=float(p.get("lot",0) or 0)',
      'sl=float(p.get("sl",0) or 0)',
      'tp=float(p.get("tp",0) or 0)',
      'max_spread_points=float(p.get("max_spread_points",0) or 0)',
      'dry=bool(p.get("dry_run",True))',
      'placement=str(p.get("placement","pending") or "pending").lower()',
      'desired_entry=float(p.get("desired_entry",0) or 0)',
      'entry_offset_pts=float(p.get("entry_offset_pts",0) or 0)',
      'expire_min=int(p.get("expire_min",0) or 0)',
      'meta_login = int(p.get("meta_login",0) or 0)',
      'meta_password = str(p.get("meta_password","") or "")',
      'meta_server = str(p.get("meta_server","") or "")',
      'target_account_type = str(p.get("target_account_type","") or "").lower()',
      'strategy_tag = str(p.get("strategy_tag","core") or "core").strip().lower()',
      'if strategy_tag not in ("core","turtle_sopa","vwap_reclaim","sr_breakout"): strategy_tag = "core"',
      'allow_pyramiding = bool(p.get("allow_pyramiding", False))',
      'if not symbol or side not in ("LONG","SHORT") or lot<=0:',
      '  out={"ok":False,"error":"invalid_payload"}',
      '  cur.execute("INSERT INTO orders(ts,symbol,side,lot,entry,sl,tp,dry_run,status,detail,target_account_type,strategy_tag) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",(datetime.datetime.utcnow().isoformat(),symbol,side,lot,0,sl,tp,1,"rejected","invalid_payload",target_account_type,strategy_tag))',
      '  conn.commit(); conn.close(); print(json.dumps(out), flush=True); raise SystemExit(0)',
      'if target_account_type not in ("demo","live"):',
      '  out={"ok":False,"error":"invalid_target_account_type"}',
      '  cur.execute("INSERT INTO orders(ts,symbol,side,lot,entry,sl,tp,dry_run,status,detail,target_account_type,strategy_tag) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",(datetime.datetime.utcnow().isoformat(),symbol,side,lot,0,sl,tp,1,"rejected","invalid_target_account_type",target_account_type,strategy_tag))',
      '  conn.commit(); conn.close(); print(json.dumps(out), flush=True); raise SystemExit(0)',
      'if meta_login and meta_password and meta_server:',
      '  ok_init = mt5.initialize(login=meta_login, password=meta_password, server=meta_server)',
      'else:',
      '  ok_init = mt5.initialize()',
      'if not ok_init:',
      '  out={"ok":False,"error":"mt5_initialize_failed","detail":str(mt5.last_error())}',
      'ai = mt5.account_info()',
      'if ai is None:',
      '  out={"ok":False,"error":"account_info_unavailable"}',
      '  mt5.shutdown()',
      '  cur.execute("INSERT INTO orders(ts,symbol,side,lot,entry,sl,tp,dry_run,status,detail,target_account_type,strategy_tag) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",(datetime.datetime.utcnow().isoformat(),symbol,side,lot,0,sl,tp,1,"error","account_info_unavailable",target_account_type,strategy_tag))',
      '  conn.commit(); conn.close(); print(json.dumps(out), flush=True); raise SystemExit(0)',
      'if meta_login and int(ai.login) != int(meta_login):',
      '  out={"ok":False,"error":"account_mismatch","detail":f"connected={ai.login} expected={meta_login}"}',
      '  mt5.shutdown()',
      '  cur.execute("INSERT INTO orders(ts,symbol,side,lot,entry,sl,tp,dry_run,status,detail,target_account_type,strategy_tag) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",(datetime.datetime.utcnow().isoformat(),symbol,side,lot,0,sl,tp,1,"rejected",out["detail"],target_account_type,strategy_tag))',
      '  conn.commit(); conn.close(); print(json.dumps(out), flush=True); raise SystemExit(0)',
      'trade_mode = int(getattr(ai,"trade_mode",-1))',
      'current_account_type = "demo" if trade_mode == 0 else ("live" if trade_mode == 2 else "unknown")',
      'if current_account_type != target_account_type:',
      '  out={"ok":False,"error":"target_account_mismatch","detail":f"connected={current_account_type} expected={target_account_type}"}',
      '  mt5.shutdown()',
      '  cur.execute("INSERT INTO orders(ts,symbol,side,lot,entry,sl,tp,dry_run,status,detail,target_account_type,strategy_tag) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",(datetime.datetime.utcnow().isoformat(),symbol,side,lot,0,sl,tp,1,"rejected",out["detail"],target_account_type,strategy_tag))',
      '  conn.commit(); conn.close(); print(json.dumps(out), flush=True); raise SystemExit(0)',
      'if not allow_pyramiding:',
      '  open_positions = mt5.positions_get(symbol=symbol) or []',
      '  side_type = mt5.POSITION_TYPE_BUY if side=="LONG" else mt5.POSITION_TYPE_SELL',
      '  same_side = [pos for pos in open_positions if int(getattr(pos,"type",-1)) == side_type]',
      '  if len(same_side) > 0:',
      '    out={"ok":False,"error":"duplicate_position_blocked","detail":f"symbol={symbol} side={side} open_count={len(same_side)}"}',
      '    mt5.shutdown()',
      '    cur.execute("INSERT INTO orders(ts,symbol,side,lot,entry,sl,tp,dry_run,status,detail,target_account_type) VALUES(?,?,?,?,?,?,?,?,?,?,?)",(datetime.datetime.utcnow().isoformat(),symbol,side,lot,0,sl,tp,1,"rejected",out["detail"],target_account_type))',
      '    conn.commit(); conn.close(); print(json.dumps(out), flush=True); raise SystemExit(0)',
      '  pending_orders = mt5.orders_get(symbol=symbol) or []',
      '  pending_side_types_buy = (mt5.ORDER_TYPE_BUY_LIMIT, mt5.ORDER_TYPE_BUY_STOP, mt5.ORDER_TYPE_BUY_STOP_LIMIT)',
      '  pending_side_types_sell = (mt5.ORDER_TYPE_SELL_LIMIT, mt5.ORDER_TYPE_SELL_STOP, mt5.ORDER_TYPE_SELL_STOP_LIMIT)',
      '  target_pending_types = pending_side_types_buy if side=="LONG" else pending_side_types_sell',
      '  same_side_pending = [o for o in pending_orders if int(getattr(o,"type",-1)) in target_pending_types]',
      '  if len(same_side_pending) > 0:',
      '    out={"ok":False,"error":"duplicate_pending_blocked","detail":f"symbol={symbol} side={side} pending_count={len(same_side_pending)}"}',
      '    mt5.shutdown()',
      '    cur.execute("INSERT INTO orders(ts,symbol,side,lot,entry,sl,tp,dry_run,status,detail,target_account_type,strategy_tag) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",(datetime.datetime.utcnow().isoformat(),symbol,side,lot,0,sl,tp,1,"rejected",out["detail"],target_account_type,strategy_tag))',
      '    conn.commit(); conn.close(); print(json.dumps(out), flush=True); raise SystemExit(0)',
      'if not mt5.symbol_select(symbol, True):',
      '  out={"ok":False,"error":"symbol_select_failed"}',
      '  mt5.shutdown()',
      '  cur.execute("INSERT INTO orders(ts,symbol,side,lot,entry,sl,tp,dry_run,status,detail,target_account_type,strategy_tag) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",(datetime.datetime.utcnow().isoformat(),symbol,side,lot,0,sl,tp,1,"error","symbol_select_failed",target_account_type,strategy_tag))',
      '  conn.commit(); conn.close(); print(json.dumps(out), flush=True); raise SystemExit(0)',
      'tick=mt5.symbol_info_tick(symbol)',
      'if tick is None:',
      '  out={"ok":False,"error":"tick_unavailable"}',
      '  mt5.shutdown()',
      '  cur.execute("INSERT INTO orders(ts,symbol,side,lot,entry,sl,tp,dry_run,status,detail,target_account_type,strategy_tag) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",(datetime.datetime.utcnow().isoformat(),symbol,side,lot,0,sl,tp,1,"error","tick_unavailable",target_account_type,strategy_tag))',
      '  conn.commit(); conn.close(); print(json.dumps(out), flush=True); raise SystemExit(0)',
      'si=mt5.symbol_info(symbol)',
      'point=float(getattr(si,"point",0.0) or 0.0)',
      'digits=int(getattr(si,"digits",5) or 5)',
      'stops_level_pts=float(getattr(si,"trade_stops_level",0) or 0)',
      'min_dist=stops_level_pts*point if point>0 else 0.0',
      'current_ask=float(tick.ask); current_bid=float(tick.bid)',
      'spread_points=float((current_ask-current_bid)/point) if point>0 else 0.0',
      'market_entry=current_ask if side=="LONG" else current_bid',
      '# Pending modda spread check gevsek (anlik fiyati gecmedigimiz icin):',
      '# - market modda: kullanici limiti aynen uygulanir',
      '# - pending modda: limit 3x kullanici degeri (max 500pt) — anlik fiyati gecmiyoruz, sadece sablon kontrol',
      'is_pending_mode = (placement=="pending" and desired_entry>0)',
      'effective_max_spread = max_spread_points',
      'if is_pending_mode and max_spread_points>0:',
      '  effective_max_spread = min(500.0, max_spread_points*3.0)',
      'mode_label = "pending" if is_pending_mode else "market"',
      'if effective_max_spread>0 and spread_points>effective_max_spread:',
      '  out={"ok":False,"error":"spread_too_wide","detail":f"spread={spread_points:.2f}pt > max={effective_max_spread:.2f}pt (mode={mode_label})","spread_points":spread_points,"max_spread_points":effective_max_spread}',
      '  mt5.shutdown()',
      '  cur.execute("INSERT INTO orders(ts,symbol,side,lot,entry,sl,tp,dry_run,status,detail,target_account_type,strategy_tag) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",(datetime.datetime.utcnow().isoformat(),symbol,side,lot,market_entry,sl,tp,1,"rejected",out["detail"],target_account_type,strategy_tag))',
      '  conn.commit(); conn.close(); print(json.dumps(out), flush=True); raise SystemExit(0)',
      '# === Emir tipi karari (market / pending) ===',
      'pending_type=None; pending_label="market"; final_price=market_entry',
      'allow_market_fallback = bool(p.get("allow_market_fallback", False))',
      'auto_adjust_pending = bool(p.get("auto_adjust_pending", True))',
      'requested_pending = (placement=="pending" and desired_entry>0)',
      'use_pending = requested_pending',
      'pending_adjusted = False',
      'pending_original_target = 0.0',
      'if requested_pending:',
      '  target=float(desired_entry)',
      '  if side=="LONG":',
      '    target = target + entry_offset_pts*point',
      '  else:',
      '    target = target - entry_offset_pts*point',
      '  target=round(target, digits)',
      '  ref = current_ask if side=="LONG" else current_bid',
      '  gap_pts = abs(target-ref)/point if point>0 else 0',
      '  min_pts = max(stops_level_pts, 2.0)',
      '  if gap_pts < min_pts:',
      '    pending_original_target = target',
      '    # Otomatik adjust: stops_level + 2pt buffer kadar uzaga kaydir (stratejinin yonune sadik kalarak)',
      '    if auto_adjust_pending:',
      '      buffer_pts = min_pts + 2.0',
      '      # Hedef yonu: orijinal hedef ref den hangi tarafta ise, o tarafa kaydir',
      '      if target < ref:',
      '        target = round(ref - buffer_pts*point, digits)  # alttan BUY_LIMIT / SELL_STOP',
      '      elif target > ref:',
      '        target = round(ref + buffer_pts*point, digits)  # ustten BUY_STOP / SELL_LIMIT',
      '      else:',
      '        # tam ust uste — LONG icin altta limit (alis dipte), SHORT icin ustte limit',
      '        if side=="LONG":',
      '          target = round(ref - buffer_pts*point, digits)',
      '        else:',
      '          target = round(ref + buffer_pts*point, digits)',
      '      pending_adjusted = True',
      '      gap_pts = abs(target-ref)/point if point>0 else 0',
      '    elif allow_market_fallback:',
      '      use_pending = False',
      '    else:',
      '      reason=f"pending_too_close_to_market gap={gap_pts:.1f}pt min={min_pts:.1f}pt target={target} ref={ref}"',
      '      out={"ok":False,"error":"pending_too_close","detail":reason,"gap_points":gap_pts,"stops_level_pts":stops_level_pts,"target":target,"market_ref":ref,"spread_points":spread_points}',
      '      mt5.shutdown()',
      '      cur.execute("INSERT INTO orders(ts,symbol,side,lot,entry,sl,tp,dry_run,status,detail,target_account_type,strategy_tag) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",(datetime.datetime.utcnow().isoformat(),symbol,side,lot,target,sl,tp,1,"rejected",reason,target_account_type,strategy_tag))',
      '      conn.commit(); conn.close(); print(json.dumps(out), flush=True); raise SystemExit(0)',
      '  if use_pending:',
      '    if side=="LONG":',
      '      pending_type = mt5.ORDER_TYPE_BUY_LIMIT if target < ref else mt5.ORDER_TYPE_BUY_STOP',
      '      pending_label = "BUY_LIMIT" if target < ref else "BUY_STOP"',
      '    else:',
      '      pending_type = mt5.ORDER_TYPE_SELL_LIMIT if target > ref else mt5.ORDER_TYPE_SELL_STOP',
      '      pending_label = "SELL_LIMIT" if target > ref else "SELL_STOP"',
      '    final_price = target',
      '# SL/TP minimum mesafe dogrulamasi',
      'def _violates_stops(price, sl_v, tp_v, is_long):',
      '  if min_dist<=0: return ""',
      '  if is_long:',
      '    if sl_v>0 and (price-sl_v)<min_dist: return f"SL {abs(price-sl_v)/point:.1f}pt < min {stops_level_pts}pt"',
      '    if tp_v>0 and (tp_v-price)<min_dist: return f"TP {abs(tp_v-price)/point:.1f}pt < min {stops_level_pts}pt"',
      '  else:',
      '    if sl_v>0 and (sl_v-price)<min_dist: return f"SL {abs(sl_v-price)/point:.1f}pt < min {stops_level_pts}pt"',
      '    if tp_v>0 and (price-tp_v)<min_dist: return f"TP {abs(price-tp_v)/point:.1f}pt < min {stops_level_pts}pt"',
      '  return ""',
      'violation=_violates_stops(final_price, sl, tp, side=="LONG")',
      'if violation:',
      '  out={"ok":False,"error":"stops_too_tight","detail":violation,"stops_level_pts":stops_level_pts,"final_price":final_price}',
      '  mt5.shutdown()',
      '  cur.execute("INSERT INTO orders(ts,symbol,side,lot,entry,sl,tp,dry_run,status,detail,target_account_type,strategy_tag) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",(datetime.datetime.utcnow().isoformat(),symbol,side,lot,final_price,sl,tp,1,"rejected",violation,target_account_type,strategy_tag))',
      '  conn.commit(); conn.close(); print(json.dumps(out), flush=True); raise SystemExit(0)',
      'if dry:',
      '  out={"ok":True,"dry_run":True,"symbol":symbol,"side":side,"lot":lot,"entry":final_price,"sl":sl,"tp":tp,"spread_points":spread_points,"placement":pending_label,"market_entry":market_entry,"pending_adjusted":pending_adjusted,"original_target":pending_original_target,"expire_min":expire_min,"target_account_type":target_account_type,"connected_account_type":current_account_type,"connected_account_login":int(getattr(ai,"login",0) or 0)}',
      '  cur.execute("INSERT INTO orders(ts,symbol,side,lot,entry,sl,tp,dry_run,status,detail,target_account_type,strategy_tag) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",(datetime.datetime.utcnow().isoformat(),symbol,side,lot,final_price,sl,tp,1,"dry_run",f"preview {pending_label}",target_account_type,strategy_tag))',
      '  conn.commit(); conn.close(); mt5.shutdown(); print(json.dumps(out), flush=True); raise SystemExit(0)',
      'order_comment = ("crt-"+strategy_tag)[:28]',
      'if use_pending:',
      '  # Broker hangi expiration modlarini destekler? (bitmask)',
      '  exp_mode_mask = int(getattr(si,"expiration_mode",1) or 1)',
      '  SUP_GTC = bool(exp_mode_mask & 1)',
      '  SUP_DAY = bool(exp_mode_mask & 2)',
      '  SUP_SPECIFIED = bool(exp_mode_mask & 4)',
      '  SUP_SPECIFIED_DAY = bool(exp_mode_mask & 8)',
      '  type_time = mt5.ORDER_TIME_GTC',
      '  expiration_ts = 0',
      '  if expire_min>0:',
      '    # Broker server time (broker timezone) — anlik tick zamanini referans al',
      '    server_now = int(getattr(tick,"time",0) or 0)',
      '    if server_now<=0:',
      '      server_now = int(datetime.datetime.now().timestamp())',
      '    target_ts = server_now + expire_min*60',
      '    if SUP_SPECIFIED:',
      '      type_time = mt5.ORDER_TIME_SPECIFIED',
      '      expiration_ts = target_ts',
      '    elif SUP_SPECIFIED_DAY:',
      '      type_time = mt5.ORDER_TIME_SPECIFIED_DAY',
      '      expiration_ts = target_ts',
      '    elif SUP_DAY:',
      '      # SPECIFIED desteklenmiyorsa gun sonuna kadar',
      '      type_time = mt5.ORDER_TIME_DAY',
      '      expiration_ts = 0',
      '    else:',
      '      type_time = mt5.ORDER_TIME_GTC',
      '      expiration_ts = 0',
      '  req={ "action": mt5.TRADE_ACTION_PENDING, "symbol": symbol, "volume": lot, "type": pending_type, "price": final_price, "sl": sl, "tp": tp, "deviation": 20, "magic": 20260506, "comment": order_comment, "type_time": type_time, "type_filling": mt5.ORDER_FILLING_RETURN }',
      '  if expiration_ts>0:',
      '    req["expiration"] = expiration_ts',
      'else:',
      '  order_type = mt5.ORDER_TYPE_BUY if side=="LONG" else mt5.ORDER_TYPE_SELL',
      '  req={ "action": mt5.TRADE_ACTION_DEAL, "symbol": symbol, "volume": lot, "type": order_type, "price": final_price, "sl": sl, "tp": tp, "deviation": 20, "magic": 20260506, "comment": order_comment, "type_time": mt5.ORDER_TIME_GTC, "type_filling": mt5.ORDER_FILLING_IOC }',
      'result=mt5.order_send(req)',
      'ok=bool(result and result.retcode in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED))',
      '# Eger pending FILLING modu reddedilirse, diger filling modlari ile tekrar dene',
      'if not ok and result and int(getattr(result,"retcode",0)) in (10030,):',
      '  for ft in (mt5.ORDER_FILLING_FOK, mt5.ORDER_FILLING_IOC, mt5.ORDER_FILLING_RETURN):',
      '    if req.get("type_filling")==ft: continue',
      '    req["type_filling"]=ft',
      '    result=mt5.order_send(req)',
      '    ok=bool(result and result.retcode in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED))',
      '    if ok: break',
      '# Invalid expiration (10022) ise GTC ile tekrar dene',
      'if not ok and result and int(getattr(result,"retcode",0))==10022 and use_pending:',
      '  req["type_time"]=mt5.ORDER_TIME_GTC',
      '  if "expiration" in req: del req["expiration"]',
      '  result=mt5.order_send(req)',
      '  ok=bool(result and result.retcode in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED))',
      '  if not ok and result and int(getattr(result,"retcode",0))==10022:',
      '    # Hala invalid ise DAY dene',
      '    req["type_time"]=mt5.ORDER_TIME_DAY',
      '    result=mt5.order_send(req)',
      '    ok=bool(result and result.retcode in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED))',
      'detail=str(getattr(result,"comment","")) if result else "no_result"',
      'ticket=int(getattr(result,"order",0) or getattr(result,"deal",0) or 0) if result else 0',
      'out={"ok":ok,"dry_run":False,"ticket":ticket,"symbol":symbol,"side":side,"lot":lot,"entry":final_price,"sl":sl,"tp":tp,"spread_points":spread_points,"placement":pending_label,"market_entry":market_entry,"stops_level_pts":stops_level_pts,"pending_adjusted":pending_adjusted,"original_target":pending_original_target,"expire_min":expire_min,"retcode":int(getattr(result,"retcode",0) or 0),"detail":detail,"target_account_type":target_account_type,"strategy_tag":strategy_tag,"connected_account_type":current_account_type,"connected_account_login":int(getattr(ai,"login",0) or 0)}',
      'cur.execute("INSERT INTO orders(ts,symbol,side,lot,entry,sl,tp,dry_run,status,detail,target_account_type,strategy_tag) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",(datetime.datetime.utcnow().isoformat(),symbol,side,lot,final_price,sl,tp,0,("sent" if ok else "rejected"),json.dumps(out),target_account_type,strategy_tag))',
      'conn.commit(); conn.close(); mt5.shutdown(); print(json.dumps(out), flush=True)'
    ].join('\n');
    const { stdout } = await pyExec(pyCode, [JSON.stringify(payload), DB_PATH]);
    const j = JSON.parse((stdout || '').trim() || '{}');
    logEvent(j.ok ? 'info' : 'warn', 'execute_order.result', {
      ok: !!j.ok,
      symbol: j.symbol || payload.symbol || '',
      side: j.side || payload.side || '',
      dry_run: !!j.dry_run,
      error: j.error || '',
      detail: j.detail || '',
      elapsed_ms: Date.now() - startedAt
    });
    writeJson(res, j.ok ? 200 : 400, j);
  } catch (err) {
    logEvent('error', 'execute_order.failed', { detail: err.message, elapsed_ms: Date.now() - startedAt });
    writeJson(res, 500, { ok: false, error: 'execute_failed', detail: err.message });
  }
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const routePath = parsedUrl.pathname;

  if (req.method === 'OPTIONS') {
    writeJson(res, 204, {});
    return;
  }

  if (routePath === '/api/crt-analyze' && req.method === 'POST') {
    handleAnalyze(req, res);
    return;
  }
  if (routePath === '/api/broker-candles' && req.method === 'POST') {
    handleBrokerCandles(req, res);
    return;
  }
  if (routePath === '/api/health' && req.method === 'GET') {
    handleHealth(req, res);
    return;
  }
  if (routePath === '/api/execute-order' && req.method === 'POST') {
    handleExecuteOrder(req, res);
    return;
  }
  if (routePath === '/api/trade-snapshot' && req.method === 'GET') {
    handleTradeSnapshot(req, res);
    return;
  }
  if (routePath === '/api/manage-positions' && req.method === 'POST') {
    handleManagePositions(req, res);
    return;
  }
  if (routePath === '/api/reset-portfolio-state' && req.method === 'POST') {
    handleResetPortfolioState(req, res);
    return;
  }
  if (routePath === '/api/debug-log' && req.method === 'GET') {
    const limit = Math.max(20, Math.min(1000, Number(parsedUrl.searchParams.get('limit') || 200)));
    const lines = tailLines(DEBUG_LOG_PATH, limit);
    writeJson(res, 200, { ok: true, path: DEBUG_LOG_PATH, lines });
    return;
  }
  if (routePath === '/api/knowledge-index' && req.method === 'GET') {
    const files = getKnowledgeIndex();
    writeJson(res, 200, { ok: true, knowledge_dir: KNOWLEDGE_DIR, count: files.length, files });
    return;
  }
  if (routePath === '/api/available-pairs' && req.method === 'POST') {
    handleAvailablePairs(req, res);
    return;
  }
  if (routePath === '/api/list-all-symbols' && (req.method === 'POST' || req.method === 'GET')) {
    handleListAllSymbols(req, res);
    return;
  }
  if (routePath === '/api/cancel-pending' && req.method === 'POST') {
    handleCancelPending(req, res);
    return;
  }
  if (routePath === '/api/close-position' && req.method === 'POST') {
    handleClosePosition(req, res);
    return;
  }

  logEvent('warn', 'route.not_found', { method: req.method, url: req.url });
  writeJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`CRT AI proxy calisiyor: http://127.0.0.1:${PORT}`);
  logEvent('info', 'server.started', { port: PORT, debug_log_path: DEBUG_LOG_PATH });
});
