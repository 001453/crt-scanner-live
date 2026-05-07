const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 8787);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_URL = process.env.OPENAI_URL || 'https://api.openai.com/v1/responses';
const DB_PATH = process.env.CRT_DB_PATH || 'C:/Users/nihat/Projects/crt-scanner/data/trade_log.db';
const ALLOW_REAL_TRADING = String(process.env.ALLOW_REAL_TRADING || 'false').toLowerCase() === 'true';
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

function pyExec(code, args = []) {
  return execFileAsync('py', ['-c', code, ...args], {
    timeout: 30000,
    maxBuffer: 1024 * 1024
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

async function handleHealth(_req, res) {
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
  } catch (err) {
    writeJson(res, 500, { ok: false, error: 'Health check failed', detail: err.message });
  }
}

async function handleExecuteOrder(req, res) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body || '{}');
    const targetAccountType = String(payload.target_account_type || '').trim().toLowerCase();
    if (!['demo', 'live'].includes(targetAccountType)) {
      writeJson(res, 400, {
        ok: false,
        error: 'invalid_target_account_type',
        detail: 'target_account_type demo veya live olmalidir.'
      });
      return;
    }
    if (targetAccountType === 'live' && !ALLOW_REAL_TRADING) {
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
      'cur.execute("""CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, symbol TEXT, side TEXT, lot REAL, entry REAL, sl REAL, tp REAL, dry_run INTEGER, status TEXT, detail TEXT, target_account_type TEXT)""")',
      'cols=[r[1] for r in cur.execute("PRAGMA table_info(orders)").fetchall()]',
      'if "target_account_type" not in cols:',
      '  cur.execute("ALTER TABLE orders ADD COLUMN target_account_type TEXT")',
      'symbol=str(p.get("symbol","")).strip()',
      'side=str(p.get("side","")).upper()',
      'lot=float(p.get("lot",0) or 0)',
      'sl=float(p.get("sl",0) or 0)',
      'tp=float(p.get("tp",0) or 0)',
      'dry=bool(p.get("dry_run",True))',
      'meta_login = int(p.get("meta_login",0) or 0)',
      'meta_password = str(p.get("meta_password","") or "")',
      'meta_server = str(p.get("meta_server","") or "")',
      'target_account_type = str(p.get("target_account_type","") or "").lower()',
      'allow_pyramiding = bool(p.get("allow_pyramiding", False))',
      'if not symbol or side not in ("LONG","SHORT") or lot<=0:',
      '  out={"ok":False,"error":"invalid_payload"}',
      '  cur.execute("INSERT INTO orders(ts,symbol,side,lot,entry,sl,tp,dry_run,status,detail,target_account_type) VALUES(?,?,?,?,?,?,?,?,?,?,?)",(datetime.datetime.utcnow().isoformat(),symbol,side,lot,0,sl,tp,1,"rejected","invalid_payload",target_account_type))',
      '  conn.commit(); conn.close(); print(json.dumps(out), flush=True); raise SystemExit(0)',
      'if target_account_type not in ("demo","live"):',
      '  out={"ok":False,"error":"invalid_target_account_type"}',
      '  cur.execute("INSERT INTO orders(ts,symbol,side,lot,entry,sl,tp,dry_run,status,detail,target_account_type) VALUES(?,?,?,?,?,?,?,?,?,?,?)",(datetime.datetime.utcnow().isoformat(),symbol,side,lot,0,sl,tp,1,"rejected","invalid_target_account_type",target_account_type))',
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
      '  cur.execute("INSERT INTO orders(ts,symbol,side,lot,entry,sl,tp,dry_run,status,detail,target_account_type) VALUES(?,?,?,?,?,?,?,?,?,?,?)",(datetime.datetime.utcnow().isoformat(),symbol,side,lot,0,sl,tp,1,"error","account_info_unavailable",target_account_type))',
      '  conn.commit(); conn.close(); print(json.dumps(out), flush=True); raise SystemExit(0)',
      'if meta_login and int(ai.login) != int(meta_login):',
      '  out={"ok":False,"error":"account_mismatch","detail":f"connected={ai.login} expected={meta_login}"}',
      '  mt5.shutdown()',
      '  cur.execute("INSERT INTO orders(ts,symbol,side,lot,entry,sl,tp,dry_run,status,detail,target_account_type) VALUES(?,?,?,?,?,?,?,?,?,?,?)",(datetime.datetime.utcnow().isoformat(),symbol,side,lot,0,sl,tp,1,"rejected",out["detail"],target_account_type))',
      '  conn.commit(); conn.close(); print(json.dumps(out), flush=True); raise SystemExit(0)',
      'trade_mode = int(getattr(ai,"trade_mode",-1))',
      'current_account_type = "demo" if trade_mode == 0 else ("live" if trade_mode == 2 else "unknown")',
      'if current_account_type != target_account_type:',
      '  out={"ok":False,"error":"target_account_mismatch","detail":f"connected={current_account_type} expected={target_account_type}"}',
      '  mt5.shutdown()',
      '  cur.execute("INSERT INTO orders(ts,symbol,side,lot,entry,sl,tp,dry_run,status,detail,target_account_type) VALUES(?,?,?,?,?,?,?,?,?,?,?)",(datetime.datetime.utcnow().isoformat(),symbol,side,lot,0,sl,tp,1,"rejected",out["detail"],target_account_type))',
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
      'if not mt5.symbol_select(symbol, True):',
      '  out={"ok":False,"error":"symbol_select_failed"}',
      '  mt5.shutdown()',
      '  cur.execute("INSERT INTO orders(ts,symbol,side,lot,entry,sl,tp,dry_run,status,detail,target_account_type) VALUES(?,?,?,?,?,?,?,?,?,?,?)",(datetime.datetime.utcnow().isoformat(),symbol,side,lot,0,sl,tp,1,"error","symbol_select_failed",target_account_type))',
      '  conn.commit(); conn.close(); print(json.dumps(out), flush=True); raise SystemExit(0)',
      'tick=mt5.symbol_info_tick(symbol)',
      'if tick is None:',
      '  out={"ok":False,"error":"tick_unavailable"}',
      '  mt5.shutdown()',
      '  cur.execute("INSERT INTO orders(ts,symbol,side,lot,entry,sl,tp,dry_run,status,detail,target_account_type) VALUES(?,?,?,?,?,?,?,?,?,?,?)",(datetime.datetime.utcnow().isoformat(),symbol,side,lot,0,sl,tp,1,"error","tick_unavailable",target_account_type))',
      '  conn.commit(); conn.close(); print(json.dumps(out), flush=True); raise SystemExit(0)',
      'entry=float(tick.ask if side=="LONG" else tick.bid)',
      'if dry:',
      '  out={"ok":True,"dry_run":True,"symbol":symbol,"side":side,"lot":lot,"entry":entry,"sl":sl,"tp":tp,"target_account_type":target_account_type,"connected_account_type":current_account_type,"connected_account_login":int(getattr(ai,"login",0) or 0)}',
      '  cur.execute("INSERT INTO orders(ts,symbol,side,lot,entry,sl,tp,dry_run,status,detail,target_account_type) VALUES(?,?,?,?,?,?,?,?,?,?,?)",(datetime.datetime.utcnow().isoformat(),symbol,side,lot,entry,sl,tp,1,"dry_run","preview",target_account_type))',
      '  conn.commit(); conn.close(); mt5.shutdown(); print(json.dumps(out), flush=True); raise SystemExit(0)',
      'order_type = mt5.ORDER_TYPE_BUY if side=="LONG" else mt5.ORDER_TYPE_SELL',
      'req={ "action": mt5.TRADE_ACTION_DEAL, "symbol": symbol, "volume": lot, "type": order_type, "price": entry, "sl": sl, "tp": tp, "deviation": 20, "magic": 20260506, "comment": "crt-auto", "type_time": mt5.ORDER_TIME_GTC, "type_filling": mt5.ORDER_FILLING_IOC }',
      'result=mt5.order_send(req)',
      'ok=bool(result and result.retcode in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED))',
      'detail=str(getattr(result,"comment","")) if result else "no_result"',
      'ticket=int(getattr(result,"order",0) or getattr(result,"deal",0) or 0) if result else 0',
      'out={"ok":ok,"dry_run":False,"ticket":ticket,"symbol":symbol,"side":side,"lot":lot,"entry":entry,"sl":sl,"tp":tp,"retcode":int(getattr(result,"retcode",0) or 0),"detail":detail,"target_account_type":target_account_type,"connected_account_type":current_account_type,"connected_account_login":int(getattr(ai,"login",0) or 0)}',
      'cur.execute("INSERT INTO orders(ts,symbol,side,lot,entry,sl,tp,dry_run,status,detail,target_account_type) VALUES(?,?,?,?,?,?,?,?,?,?,?)",(datetime.datetime.utcnow().isoformat(),symbol,side,lot,entry,sl,tp,0,("sent" if ok else "rejected"),json.dumps(out),target_account_type))',
      'conn.commit(); conn.close(); mt5.shutdown(); print(json.dumps(out), flush=True)'
    ].join('\n');
    const { stdout } = await pyExec(pyCode, [JSON.stringify(payload), DB_PATH]);
    const j = JSON.parse((stdout || '').trim() || '{}');
    writeJson(res, j.ok ? 200 : 400, j);
  } catch (err) {
    writeJson(res, 500, { ok: false, error: 'execute_failed', detail: err.message });
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
  if (req.url === '/api/health' && req.method === 'GET') {
    handleHealth(req, res);
    return;
  }
  if (req.url === '/api/execute-order' && req.method === 'POST') {
    handleExecuteOrder(req, res);
    return;
  }

  writeJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`CRT AI proxy calisiyor: http://127.0.0.1:${PORT}`);
});
