const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const execFileAsync = promisify(execFile);

// .env loader (built-in, dotenv'siz). Proje root'taki .env'yi okur, mevcut env vars'i override etmez.
(function loadDotEnv() {
  try {
    const envFile = String(process.env.ENV_FILE || '.env').trim();
    const envPath = path.isAbsolute(envFile) ? envFile : path.join(__dirname, envFile);
    const forceFromFile = envFile !== '.env';
    const forceKeys = new Set([
      'PORT', 'MT5_LOGIN', 'MT5_PASSWORD', 'MT5_SERVER', 'MT5_PATH',
      'CRT_DB_PATH', 'CRT_MANAGE_CFG_PATH', 'CRT_DEBUG_LOG_PATH'
    ]);
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, 'utf8');
    raw.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const idx = trimmed.indexOf('=');
      if (idx <= 0) return;
      const key = trimmed.slice(0, idx).trim();
      let val = trimmed.slice(idx + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined || (forceFromFile && forceKeys.has(key))) process.env[key] = val;
    });
    console.log(`[env] .env yuklendi (${envPath})`);
  } catch (e) {
    console.log(`[env] .env yuklenemedi: ${e.message}`);
  }
})();


function resolveProjectPath(p, fallbackRelative) {
  const raw = String(p || '').trim();
  const target = raw || fallbackRelative;
  return path.isAbsolute(target) ? target : path.join(__dirname, target.replace(/^\.\//, ''));
}

const PORT = Number(process.env.PORT || 8790);
const LISTEN_HOST = String(process.env.CRT_LISTEN_HOST || '127.0.0.1').trim() || '127.0.0.1';
const PROXY_TOKEN = String(process.env.CRT_PROXY_TOKEN || '').trim();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_URL = process.env.OPENAI_URL || 'https://api.openai.com/v1/responses';
const DB_PATH = resolveProjectPath(process.env.CRT_DB_PATH, 'data/trade_log.db');
const MANAGE_CFG_PATH = resolveProjectPath(process.env.CRT_MANAGE_CFG_PATH, 'data/manage_cfg.json');
const TRENDGRID334_GUARD_PATH = resolveProjectPath(process.env.CRT_TRENDGRID334_GUARD_PATH, 'data/trendgrid334_guard.json');
const TRENDGRID334_MAGIC = 334001;
const TRENDGRID334_COMMENT_PREFIX = 'TG334';
const TRENDGRID334_DEFAULT_SYMBOL = 'EURUSD';
const QUICK_TP_USD = Math.max(0, Number(process.env.CRT_QUICK_TP_USD || 2));
const MAX_SL_USD = Math.max(0, Number(process.env.CRT_MAX_SL_USD || 8));

const DEFAULT_TRENDGRID334_GUARD = {
  active: true,
  symbol: TRENDGRID334_DEFAULT_SYMBOL,
  magic: TRENDGRID334_MAGIC,
  comment_prefix: TRENDGRID334_COMMENT_PREFIX
};

const PLAN_CFG_PRODUCTION_PATH = resolveProjectPath(process.env.CRT_PLAN_CFG_PRODUCTION_PATH, 'data/plan_cfg_production.json');

function loadPlanCfgProduction() {
  try {
    if (fs.existsSync(PLAN_CFG_PRODUCTION_PATH)) {
      return JSON.parse(fs.readFileSync(PLAN_CFG_PRODUCTION_PATH, 'utf8'));
    }
  } catch (_) { /* ignore */ }
  return { version: 20260622 };
}

function loadTrendGrid334Guard() {
  try {
    if (fs.existsSync(TRENDGRID334_GUARD_PATH)) {
      const saved = JSON.parse(fs.readFileSync(TRENDGRID334_GUARD_PATH, 'utf8'));
      return { ...DEFAULT_TRENDGRID334_GUARD, ...saved };
    }
  } catch (_) { /* ignore */ }
  return { ...DEFAULT_TRENDGRID334_GUARD };
}

function saveTrendGrid334Guard(payload) {
  const merged = { ...DEFAULT_TRENDGRID334_GUARD, ...(payload && typeof payload === 'object' ? payload : {}) };
  merged.active = !!merged.active;
  merged.symbol = String(merged.symbol || TRENDGRID334_DEFAULT_SYMBOL).trim().toUpperCase() || TRENDGRID334_DEFAULT_SYMBOL;
  merged.magic = Number(merged.magic || TRENDGRID334_MAGIC) || TRENDGRID334_MAGIC;
  merged.comment_prefix = String(merged.comment_prefix || TRENDGRID334_COMMENT_PREFIX).trim() || TRENDGRID334_COMMENT_PREFIX;
  fs.mkdirSync(path.dirname(TRENDGRID334_GUARD_PATH), { recursive: true });
  fs.writeFileSync(TRENDGRID334_GUARD_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

function isTrendGrid334ExclusiveSymbol(symbol) {
  const guard = loadTrendGrid334Guard();
  if (!guard.active) return false;
  const sym = String(symbol || '').trim().toUpperCase();
  const reserved = String(guard.symbol || TRENDGRID334_DEFAULT_SYMBOL).trim().toUpperCase();
  return sym === reserved;
}

const PY_TG334_SKIP_LINES = [
  'def is_tg334_owned(obj):',
  `  magic=int(getattr(obj,"magic",0) or 0)`,
  '  comment=str(getattr(obj,"comment","") or "")',
  `  return magic==${TRENDGRID334_MAGIC} or comment.startswith("${TRENDGRID334_COMMENT_PREFIX}")`
];

const DEFAULT_MANAGE_CFG = {
  tp1_rr: 999,
  be_at_r: 999,
  trail_at_r: 999,
  partial_close_pct: 0,
  early_manage_usd: 0,
  trail_activate_usd: 0,
  trail_target_usd: QUICK_TP_USD,
  trail_pullback_usd: 0,
  lock_sl_until_usd_tp: true,
  sl_usd_max: MAX_SL_USD,
  portfolio_tp_usd: 0,
  portfolio_sl_usd: 0,
  portfolio_be_usd: 0,
  portfolio_trail_activate_usd: 0,
  portfolio_trail_drawdown_usd: 0,
  category_baskets: {},
  pair_categories: {}
};

function normalizeManagePayload(payload) {
  const p = { ...(payload && typeof payload === 'object' ? payload : {}) };
  if (!p.lock_sl_until_usd_tp) return p;
  p.trail_target_usd = QUICK_TP_USD;
  p.trail_activate_usd = 0;
  p.trail_pullback_usd = 0;
  p.tp1_rr = 999;
  p.be_at_r = 999;
  p.trail_at_r = 999;
  p.partial_close_pct = 0;
  p.early_manage_usd = 0;
  p.portfolio_tp_usd = 0;
  p.portfolio_sl_usd = 0;
  p.portfolio_be_usd = 0;
  p.portfolio_trail_activate_usd = 0;
  p.portfolio_trail_drawdown_usd = 0;
  p.sl_usd_max = MAX_SL_USD;
  return p;
}

function loadManageCfg() {
  try {
    if (fs.existsSync(MANAGE_CFG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(MANAGE_CFG_PATH, 'utf8'));
      return normalizeManagePayload({ ...DEFAULT_MANAGE_CFG, ...saved });
    }
  } catch (_) { /* ignore */ }
  return { ...DEFAULT_MANAGE_CFG };
}

function saveManageCfg(payload) {
  try {
    ensureDebugDir();
    const merged = normalizeManagePayload({ ...loadManageCfg(), ...(payload && typeof payload === 'object' ? payload : {}) });
    fs.writeFileSync(MANAGE_CFG_PATH, JSON.stringify(merged));
  } catch (_) { /* ignore */ }
}
const KNOWLEDGE_DIR = resolveProjectPath(process.env.CRT_KNOWLEDGE_DIR, 'knowledge');
const ALLOW_REAL_TRADING = String(process.env.ALLOW_REAL_TRADING || 'false').toLowerCase() === 'true';
const OANDA_API_KEY = process.env.OANDA_API_KEY;
const OANDA_ENV = (process.env.OANDA_ENV || 'practice').toLowerCase();
const OANDA_BASE_URL = OANDA_ENV === 'live'
  ? 'https://api-fxtrade.oanda.com/v3'
  : 'https://api-fxpractice.oanda.com/v3';
const DEBUG_ENABLED = String(process.env.CRT_DEBUG_LOG || 'true').toLowerCase() === 'true';
const DEBUG_LOG_PATH = resolveProjectPath(process.env.CRT_DEBUG_LOG_PATH, 'data/debug.log');
const EDGES_PATH = resolveProjectPath(process.env.CRT_EDGES_PATH, 'data/edges.json');
const edgeEngine = require('./edge_engine');
let edgesDbCache = null;
function loadEdgesDb() {
  if (edgesDbCache) return edgesDbCache;
  if (!fs.existsSync(EDGES_PATH)) {
    edgesDbCache = { version: 0, pairs: {}, categoryProfiles: { default: 'EURUSD' } };
    return edgesDbCache;
  }
  edgesDbCache = JSON.parse(fs.readFileSync(EDGES_PATH, 'utf8'));
  return edgesDbCache;
}
// MT5 hesap bilgileri .env'den (browser localStorage'da plaintext sifre tutmaktan guvenli).
// Eger bunlar setli ise frontend'den gelen meta_login/meta_password/meta_server'i override eder.
const MT5_LOGIN_ENV = String(process.env.MT5_LOGIN || '').trim();
const MT5_PASSWORD_ENV = String(process.env.MT5_PASSWORD || '');
const MT5_SERVER_ENV = String(process.env.MT5_SERVER || '').trim();
const MT5_PATH_ENV = String(process.env.MT5_PATH || '').trim();
const CRT_MIRROR_ENABLED = String(process.env.CRT_MIRROR_ENABLED || 'false').toLowerCase() === 'true';
const CRT_MIRROR_URL = String(process.env.CRT_MIRROR_URL || 'http://127.0.0.1:8791/api/execute-order').trim();
const CRT_MIRROR_SNAPSHOT_URL = String(process.env.CRT_MIRROR_SNAPSHOT_URL || 'http://127.0.0.1:8791/api/trade-snapshot').trim();
const CRT_MIRROR_CANCEL_URL = String(
  process.env.CRT_MIRROR_CANCEL_URL || CRT_MIRROR_URL.replace(/\/execute-order\/?$/i, '/cancel-pending')
).trim();
const CRT_MIRROR_BALANCE = Math.max(50, Number(process.env.CRT_MIRROR_BALANCE || 500));
const CRT_PRIMARY_BALANCE = Math.max(50, Number(process.env.CRT_PRIMARY_BALANCE || 365));
const CRT_MIRROR_VOLUME_MIN = Math.max(0.01, Number(process.env.CRT_MIRROR_VOLUME_MIN || 0.01));
const CRT_MIRROR_VOLUME_STEP = Math.max(0.01, Number(process.env.CRT_MIRROR_VOLUME_STEP || 0.01));
const CRT_MIRROR_SYMBOL_SUFFIX = String(process.env.CRT_MIRROR_SYMBOL_SUFFIX || '.r').trim();
const CRT_MIRROR_SKIP_INDICES = String(process.env.CRT_MIRROR_SKIP_INDICES || 'true').toLowerCase() !== 'false';
const CRT_MIRROR_CLOSE_URL = String(
  process.env.CRT_MIRROR_CLOSE_URL || CRT_MIRROR_URL.replace(/\/execute-order\/?$/i, '/close-position')
).trim();
// Manuel kapatma (dashboard Kapat) ikinci hesaba yansimasin — sadece broker TP/SL ile kapansin.
const CRT_MIRROR_CLOSE_ON_MANUAL = String(process.env.CRT_MIRROR_CLOSE_ON_MANUAL || 'false').toLowerCase() === 'true';
const CRT_MIRROR_SCALE_LOT = String(process.env.CRT_MIRROR_SCALE_LOT || 'false').toLowerCase() === 'true';
const MIRROR_DISMISS_TICKS = Math.max(2, Number(process.env.CRT_MIRROR_DISMISS_TICKS || 3));
const MIRROR_INDEX_KEYS = new Set([
  'UK100', 'NAS100', 'US30', 'US500', 'US100', 'USTEC', 'GER40', 'GER30', 'DAX40', 'EU50',
  'FRA40', 'FR40', 'SPA35', 'JPN225', 'JP225', 'AUS200', 'HK50', 'CHINA50', 'US2000', 'VIX', 'SPX500'
]);
const PY_MT5_BOOT_LINES = [
  'import os',
  'mt5_path=str(os.environ.get("MT5_PATH","") or "").strip()',
  'def _crt_mt5_init(login=0,password="",server=""):',
  '  if login and password and server:',
  '    if mt5_path: return mt5.initialize(path=mt5_path,login=int(login),password=str(password),server=str(server))',
  '    return mt5.initialize(login=int(login),password=str(password),server=str(server))',
  '  if mt5_path: return mt5.initialize(path=mt5_path)',
  '  return mt5.initialize()'
];
// Telegram .env destegi (token browser'da olmasin)
const TELEGRAM_BOT_TOKEN_ENV = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID_ENV = String(process.env.TELEGRAM_CHAT_ID || '').trim();

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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CRT-Token'
  });
  res.end(JSON.stringify(data));
}

function scaleMirrorLot(lotNum) {
  const lot = Number(lotNum || 0);
  const step = CRT_MIRROR_VOLUME_STEP;
  const min = CRT_MIRROR_VOLUME_MIN;
  if (!CRT_MIRROR_SCALE_LOT) {
    return Math.max(min, Math.round(lot / step) * step);
  }
  const scaled = lot * CRT_MIRROR_BALANCE / CRT_PRIMARY_BALANCE;
  return Math.max(min, Math.round(scaled / step) * step);
}

function mirrorSymbolKey(symbol) {
  return String(symbol || '').toUpperCase().replace(/^#/, '').replace(/\.(X|R|M|FT|CASH|CFD)$/i, '').replace(/\..+$/, '');
}

function mapMirrorSymbol(symbol) {
  const raw = String(symbol || '').trim();
  if (!raw) return raw;
  const up = raw.toUpperCase();
  const base = mirrorSymbolKey(raw);
  if (/\.(X|R|M|FT)$/i.test(raw)) {
    return `${base}${CRT_MIRROR_SYMBOL_SUFFIX || '.r'}`;
  }
  if (up.includes('.') && CRT_MIRROR_SYMBOL_SUFFIX) {
    return `${base}${CRT_MIRROR_SYMBOL_SUFFIX}`;
  }
  return raw;
}

function isIndexSymbol(symbol) {
  const k = mirrorSymbolKey(symbol);
  if (!k) return false;
  if (MIRROR_INDEX_KEYS.has(k)) return true;
  if (/^(UK|NAS|US|GER|EU|FR|AUS|HK|JPN|SPA|CHINA)\d+/i.test(k)) return true;
  if (/^(UK100|NAS100|US30|US500|GER40|JP225)/i.test(k)) return true;
  return false;
}

function mirrorSkipReason(symbol) {
  if (CRT_MIRROR_SKIP_INDICES && isIndexSymbol(symbol)) return 'index_skip_high_min_lot';
  return '';
}

function prepareMirrorPayload(sourcePayload) {
  const mp = { ...(sourcePayload && typeof sourcePayload === 'object' ? sourcePayload : {}) };
  delete mp.meta_login;
  delete mp.meta_password;
  delete mp.meta_server;
  mp.symbol = mapMirrorSymbol(mp.symbol || '');
  mp.lot = scaleMirrorLot(mp.lot || 0);
  mp.dry_run = false;
  mp.target_account_type = 'live';
  if (!mp.tp_usd_target && mp.lock_sl_until_usd_tp) mp.tp_usd_target = QUICK_TP_USD;
  if (!mp.sl_usd_max && mp.lock_sl_until_usd_tp) mp.sl_usd_max = MAX_SL_USD;
  return mp;
}

function isCrtOpenPosition(pos) {
  const c = String((pos && pos.comment) || '');
  return c.toLowerCase().startsWith('crt-');
}

function httpGetJson(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(chunks || '{}')); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('http_get_timeout')); });
  });
}

function httpPostJson(url, body, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body || {});
    const req = lib.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(chunks || '{}')); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('http_post_timeout')); });
    req.write(data);
    req.end();
  });
}

function mirrorPendingKey(symbol, side) {
  return `${mirrorSymbolKey(symbol)}|${String(side || '').toUpperCase()}`;
}

function isCrtPendingOrder(order) {
  const c = String((order && order.comment) || '');
  return c.toLowerCase().startsWith('crt-');
}

async function mirrorCancelPendingForPair(symbol, side) {
  if (!CRT_MIRROR_ENABLED || Number(PORT) !== 8790) return [];
  const sym = String(symbol || '').trim();
  const sd = String(side || '').toUpperCase();
  if (!sym || !['LONG', 'SHORT'].includes(sd)) return [];
  const key = mirrorPendingKey(sym, sd);
  const results = [];
  try {
    const mirror = await httpGetJson(CRT_MIRROR_SNAPSHOT_URL);
    const matches = (mirror.pending_orders || []).filter((m) => {
      if (!isCrtPendingOrder(m)) return false;
      return mirrorPendingKey(m.symbol, m.side) === key;
    });
    for (const m of matches) {
      const ticket = Number(m.ticket || 0);
      if (!ticket) continue;
      try {
        const cj = await httpPostJson(CRT_MIRROR_CANCEL_URL, { ticket });
        results.push({
          symbol: sym,
          side: sd,
          ticket,
          ok: !!cj.ok,
          error: cj.error || '',
          detail: cj.detail || '',
          retcode: cj.retcode || 0
        });
        logEvent(cj.ok ? 'info' : 'warn', 'mirror_cancel.pending', {
          symbol: sym,
          side: sd,
          ticket,
          ok: !!cj.ok,
          error: cj.error || '',
          detail: cj.detail || ''
        });
      } catch (err) {
        results.push({ symbol: sym, side: sd, ticket, ok: false, error: 'mirror_cancel_failed', detail: err.message });
        logEvent('warn', 'mirror_cancel.failed', { symbol: sym, side: sd, ticket, detail: err.message });
      }
    }
  } catch (err) {
    logEvent('warn', 'mirror_cancel.snapshot_failed', { symbol: sym, side: sd, detail: err.message });
  }
  return results;
}

async function mirrorPurgeIndicesOnSecondary(mirror) {
  if (!CRT_MIRROR_ENABLED || Number(PORT) !== 8790 || !CRT_MIRROR_SKIP_INDICES) return [];
  const actions = [];
  for (const m of (mirror.pending_orders || [])) {
    if (!isCrtPendingOrder(m) || !isIndexSymbol(m.symbol)) continue;
    const ticket = Number(m.ticket || 0);
    if (!ticket) continue;
    try {
      const cj = await httpPostJson(CRT_MIRROR_CANCEL_URL, { ticket });
      actions.push({ symbol: m.symbol, side: m.side, action: 'cancel_index', ok: !!cj.ok, ticket, detail: cj.detail || '' });
    } catch (err) {
      actions.push({ symbol: m.symbol, action: 'cancel_index', ok: false, ticket, error: err.message });
    }
  }
  for (const p of (mirror.open_positions || [])) {
    if (!isCrtOpenPosition(p) || !isIndexSymbol(p.symbol)) continue;
    const ticket = Number(p.ticket || 0);
    if (!ticket) continue;
    try {
      const cj = await httpPostJson(CRT_MIRROR_CLOSE_URL, { ticket });
      actions.push({ symbol: p.symbol, side: p.side, action: 'close_index', ok: !!cj.ok, ticket, detail: cj.detail || '' });
      logEvent(cj.ok ? 'info' : 'warn', 'mirror_purge.index_close', { symbol: p.symbol, ticket, ok: !!cj.ok });
    } catch (err) {
      actions.push({ symbol: p.symbol, action: 'close_index', ok: false, ticket, error: err.message });
    }
  }
  return actions;
}

async function mirrorOrderToSecondary(sourcePayload, result) {
  if (!CRT_MIRROR_ENABLED || Number(PORT) !== 8790) return null;
  if (!result || !result.ok || result.dry_run) return null;
  const skip = mirrorSkipReason(sourcePayload?.symbol || result.symbol || '');
  if (skip) {
    logEvent('info', 'mirror_order.skipped', { symbol: sourcePayload?.symbol || result.symbol || '', reason: skip });
    return { ok: true, skipped: true, reason: skip };
  }
  const sym = sourcePayload?.symbol || result.symbol || '';
  const sd = String(sourcePayload?.side || result.side || '').toUpperCase();
  if (isMirrorDismissed(sym, sd)) {
    logEvent('info', 'mirror_order.skipped', { symbol: sym, side: sd, reason: 'mirror_dismissed_until_primary_close' });
    return { ok: true, skipped: true, reason: 'mirror_dismissed_until_primary_close' };
  }
  const mp = prepareMirrorPayload({ ...sourcePayload, lot: sourcePayload?.lot || result.lot || 0 });
  try {
    const mj = await httpPostJson(CRT_MIRROR_URL, mp);
    logEvent(mj.ok ? 'info' : 'warn', 'mirror_order.result', {
      symbol: mp.symbol || '',
      side: mp.side || '',
      lot: mp.lot,
      ok: !!mj.ok,
      error: mj.error || '',
      detail: mj.detail || '',
      ticket: mj.ticket || 0
    });
    return mj;
  } catch (err) {
    logEvent('warn', 'mirror_order.failed', { detail: err.message, symbol: mp.symbol || '' });
    return null;
  }
}

async function fetchLocalTradeSnapshot() {
  const pyCode = [
    'import json',
    'import MetaTrader5 as mt5',
    ...PY_MT5_BOOT_LINES,
    pyMt5IfNotInitLine(),
    '  print(json.dumps({"ok":False,"error":"mt5_init_failed"}), flush=True)',
    '  raise SystemExit(0)',
    'pending=[]',
    'open_rows=[]',
    'for o in (mt5.orders_get() or []):',
    '  c=str(getattr(o,"comment","") or "")',
    '  if not c.startswith("crt-"): continue',
    '  ot=int(getattr(o,"type",0))',
    '  side="LONG" if ot in (mt5.ORDER_TYPE_BUY_LIMIT,mt5.ORDER_TYPE_BUY_STOP) else "SHORT"',
    '  pending.append({"symbol":str(getattr(o,"symbol","")),"side":side,"volume":float(getattr(o,"volume_current",0) or 0),"price_open":float(getattr(o,"price_open",0) or 0),"sl":float(getattr(o,"sl",0) or 0),"tp":float(getattr(o,"tp",0) or 0),"time_setup":int(getattr(o,"time_setup",0) or 0),"time_expiration":int(getattr(o,"time_expiration",0) or 0),"comment":c,"strategy_tag":c.replace("crt-","")})',
    'for p in (mt5.positions_get() or []):',
    '  c=str(getattr(p,"comment","") or "")',
    '  if not c.startswith("crt-"): continue',
    '  side="LONG" if int(getattr(p,"type",0))==mt5.POSITION_TYPE_BUY else "SHORT"',
    '  open_rows.append({"ticket":int(getattr(p,"ticket",0) or 0),"symbol":str(getattr(p,"symbol","")),"side":side,"volume":float(getattr(p,"volume",0) or 0),"price_open":float(getattr(p,"price_open",0) or 0),"sl":float(getattr(p,"sl",0) or 0),"tp":float(getattr(p,"tp",0) or 0),"comment":c,"strategy_tag":c.replace("crt-","")})',
    'mt5.shutdown()',
    'print(json.dumps({"ok":True,"pending_orders":pending,"open_positions":open_rows}, ensure_ascii=False), flush=True)'
  ].join('\n');
  const { stdout } = await pyExec(pyCode, [], { timeout: 25000 });
  return JSON.parse((stdout || '').trim() || '{}');
}

async function runMirrorSync() {
  const startedAt = Date.now();
  if (!CRT_MIRROR_ENABLED || Number(PORT) !== 8790) {
    return { ok: false, error: 'mirror_not_configured', actions: [], elapsed_ms: 0 };
  }
  const primary = await fetchLocalTradeSnapshot();
  const mirror = await httpGetJson(CRT_MIRROR_SNAPSHOT_URL);
  updateMirrorDismissState(primary, mirror);
  const actions = [...await mirrorPurgeIndicesOnSecondary(mirror)];
  for (const o of (primary.pending_orders || [])) {
    const sym = String(o.symbol || '').toUpperCase();
    const side = String(o.side || '').toUpperCase();
    if (!sym || !['LONG', 'SHORT'].includes(side)) continue;
    const skip = mirrorSkipReason(o.symbol);
    if (skip) {
      actions.push({ symbol: sym, side, ok: true, skipped: true, reason: skip });
      continue;
    }
    if (isMirrorDismissed(o.symbol, side)) {
      actions.push({ symbol: sym, side, ok: true, skipped: true, reason: 'mirror_dismissed_until_primary_close' });
      continue;
    }
    const dup = (mirror.pending_orders || []).some((m) => {
      return mirrorPendingKey(m.symbol, m.side) === mirrorPendingKey(sym, side);
    });
    if (dup) {
      actions.push({ symbol: sym, side, ok: true, skipped: true, reason: 'already_on_mirror' });
      continue;
    }
    let expireMin = 0;
    const ts = Number(o.time_setup || 0);
    const te = Number(o.time_expiration || 0);
    if (te > ts && ts > 0) expireMin = Math.max(1, Math.round((te - ts) / 60));
    const tag = String(o.strategy_tag || 'core').replace(/^crt-/, '');
    const payload = prepareMirrorPayload({
      symbol: o.symbol,
      side,
      lot: o.volume,
      sl: Number(o.sl || 0),
      tp: Number(o.tp || 0),
      placement: 'pending',
      desired_entry: Number(o.price_open || 0),
      expire_min: expireMin,
      lock_sl_until_usd_tp: true,
      strategy_tag: tag,
      max_spread_points: 0
    });
    const mj = await httpPostJson(CRT_MIRROR_URL, payload);
    actions.push({
      symbol: sym,
      side,
      ok: !!mj.ok,
      ticket: mj.ticket || 0,
      error: mj.error || '',
      detail: mj.detail || '',
      lot: payload.lot
    });
    logEvent(mj.ok ? 'info' : 'warn', 'mirror_sync.pending', {
      symbol: sym,
      side,
      ok: !!mj.ok,
      ticket: mj.ticket || 0,
      error: mj.error || ''
    });
  }
  const primaryKeys = new Set(
    (primary.pending_orders || []).map((o) => mirrorPendingKey(o.symbol, o.side))
  );
  for (const m of (mirror.pending_orders || [])) {
    if (!isCrtPendingOrder(m)) continue;
    const sym = String(m.symbol || '').toUpperCase();
    const side = String(m.side || '').toUpperCase();
    const key = mirrorPendingKey(sym, side);
    if (primaryKeys.has(key)) continue;
    if (isMirrorDismissed(m.symbol, side)) {
      const cancels = await mirrorCancelPendingForPair(m.symbol, side);
      for (const cj of cancels) {
        actions.push({ symbol: sym, side, action: 'cancel', ok: !!cj.ok, ticket: cj.ticket || 0, reason: 'dismissed_orphan' });
      }
      continue;
    }
    const cancels = await mirrorCancelPendingForPair(sym, side);
    for (const cj of cancels) {
      actions.push({
        symbol: sym,
        side,
        action: 'cancel',
        ok: !!cj.ok,
        ticket: cj.ticket || 0,
        error: cj.error || '',
        detail: cj.detail || '',
        reason: 'orphan_on_mirror'
      });
      logEvent(cj.ok ? 'info' : 'warn', 'mirror_sync.cancel', {
        symbol: sym,
        side,
        ticket: cj.ticket || 0,
        ok: !!cj.ok,
        error: cj.error || '',
        detail: cj.detail || ''
      });
    }
    if (!cancels.length) {
      actions.push({
        symbol: sym,
        side,
        action: 'cancel',
        ok: false,
        ticket: Number(m.ticket || 0),
        reason: 'orphan_on_mirror',
        error: 'mirror_cancel_no_match'
      });
    }
  }
  return { ok: true, actions, elapsed_ms: Date.now() - startedAt };
}

async function handleSyncMirrorPending(_req, res) {
  const startedAt = Date.now();
  if (!CRT_MIRROR_ENABLED || Number(PORT) !== 8790) {
    writeJson(res, 400, { ok: false, error: 'mirror_not_configured' });
    return;
  }
  try {
    const result = await runMirrorSync();
    writeJson(res, 200, result);
  } catch (err) {
    logEvent('error', 'mirror_sync.failed', { detail: err.message, elapsed_ms: Date.now() - startedAt });
    writeJson(res, 500, { ok: false, error: 'mirror_sync_failed', detail: err.message });
  }
}

// py launcher bozuk PYTHONHOME ile encodings hatasi verebilir; dogrudan python.exe + temiz env kullan.
const PYTHON_BIN = (() => {
  const fromEnv = String(process.env.CRT_PYTHON || '').trim();
  if (fromEnv) return fromEnv;
  const winDefault = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python313', 'python.exe');
  if (fs.existsSync(winDefault)) return winDefault;
  return 'python';
})();

function pyEnv() {
  const env = { ...process.env };
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  return env;
}

function pyExec(code, args = [], opts = {}) {
  return execFileAsync(PYTHON_BIN, ['-c', code, ...args], {
    timeout: opts.timeout || 30000,
    maxBuffer: opts.maxBuffer || 1024 * 1024,
    env: pyEnv()
  });
}

function pyExecStdin(code, stdinPayload = '', timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = execFile(PYTHON_BIN, ['-c', code], {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: pyEnv()
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
      ...PY_MT5_BOOT_LINES,
      'pair_id=sys.argv[1]',
      'category=sys.argv[2]',
      'gran=sys.argv[3]',
      'count=int(sys.argv[4])',
      'tz=sys.argv[5]',
      'tf_map={"M1":mt5.TIMEFRAME_M1,"M5":mt5.TIMEFRAME_M5,"M15":mt5.TIMEFRAME_M15,"M30":mt5.TIMEFRAME_M30,"H1":mt5.TIMEFRAME_H1,"H4":mt5.TIMEFRAME_H4,"D1":mt5.TIMEFRAME_D1}',
      'timeframe=tf_map.get(gran,mt5.TIMEFRAME_H1)',
      pyMt5IfNotInitLine(),
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
    const { stdout } = await pyExec(pyCode, [pairId, category, granularity, String(count), alignmentTimezone], {
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
      ...PY_MT5_BOOT_LINES,
      'raw = sys.stdin.read()',
      'p = json.loads(raw or "{}")',
      'ticket = int(p.get("ticket",0) or 0)',
      pyMt5IfNotInitLine(),
      '  print(json.dumps({"ok":False,"error":"mt5_initialize_failed","detail":str(mt5.last_error())}), flush=True)',
      '  raise SystemExit(0)',
      'pos_list = mt5.positions_get(ticket=ticket) or []',
      'if not pos_list:',
      '  mt5.shutdown()',
      '  print(json.dumps({"ok":False,"error":"position_not_found","ticket":ticket}), flush=True)',
      '  raise SystemExit(0)',
      'pos = pos_list[0]',
      'symbol = str(getattr(pos,"symbol","") or "")',
      'side = "LONG" if int(getattr(pos,"type",-1)) == mt5.POSITION_TYPE_BUY else "SHORT"',
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
      'out = {"ok":ok,"ticket":ticket,"symbol":symbol,"side":side,"retcode":rc,"detail":str(getattr(result,"comment","") or "")}',
      'mt5.shutdown()',
      'print(json.dumps(out), flush=True)'
    ].join('\n');
    const { stdout } = await pyExecStdin(pyCode, JSON.stringify({ ticket }));
    const j = JSON.parse((stdout || '').trim() || '{}');
    logEvent(j.ok ? 'info' : 'warn', 'close_position.result', {
      ok: !!j.ok, ticket, symbol: j.symbol || '', side: j.side || '', retcode: j.retcode || 0, elapsed_ms: Date.now() - startedAt
    });
    if (j.ok && j.symbol && j.side && CRT_MIRROR_CLOSE_ON_MANUAL) {
      try {
        j.mirror_close = await mirrorCloseOnSecondary(j.symbol, j.side);
      } catch (_) {
        j.mirror_close = [];
      }
    }
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
      ...PY_MT5_BOOT_LINES,
      'raw = sys.stdin.read()',
      'p = json.loads(raw or "{}")',
      'ticket = int(p.get("ticket",0) or 0)',
      pyMt5IfNotInitLine(),
      '  print(json.dumps({"ok":False,"error":"mt5_initialize_failed","detail":str(mt5.last_error())}), flush=True)',
      '  raise SystemExit(0)',
      'orders = mt5.orders_get(ticket=ticket) or []',
      'if not orders:',
      '  mt5.shutdown()',
      '  print(json.dumps({"ok":False,"error":"order_not_found","ticket":ticket}), flush=True)',
      '  raise SystemExit(0)',
      'o = orders[0]',
      'ot = int(getattr(o,"type",0))',
      'side = "LONG" if ot in (mt5.ORDER_TYPE_BUY_LIMIT, mt5.ORDER_TYPE_BUY_STOP) else "SHORT"',
      'symbol = str(getattr(o,"symbol","") or "")',
      'req = {"action": mt5.TRADE_ACTION_REMOVE, "order": ticket}',
      'result = mt5.order_send(req)',
      'ok = bool(result and result.retcode in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED))',
      'out = {"ok":ok, "ticket":ticket, "symbol":symbol, "side":side, "retcode":int(getattr(result,"retcode",0) or 0), "detail":str(getattr(result,"comment","") or "")}',
      'mt5.shutdown()',
      'print(json.dumps(out), flush=True)'
    ].join('\n');
    const { stdout } = await pyExecStdin(pyCode, JSON.stringify({ ticket }));
    const j = JSON.parse((stdout || '').trim() || '{}');
    logEvent(j.ok ? 'info' : 'warn', 'cancel_pending.result', {
      ok: !!j.ok, ticket, symbol: j.symbol || '', side: j.side || '', retcode: j.retcode || 0, elapsed_ms: Date.now() - startedAt
    });
    if (j.ok && j.symbol && j.side) {
      try {
        j.mirror_cancel = await mirrorCancelPendingForPair(j.symbol, j.side);
      } catch (_) {
        j.mirror_cancel = [];
      }
    }
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
      ...PY_MT5_BOOT_LINES,
      pyMt5IfNotInitLine(),
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
      ...PY_MT5_BOOT_LINES,
      'p=json.loads(sys.argv[1])',
      'pairs=p.get("pairs",[]) if isinstance(p,dict) else []',
      pyMt5IfNotInitLine(),
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

// Hesap durumu: balance, equity, free margin, margin level, leverage, currency.
// Frontend her snapshot'ta cagrir → riskCfg.balance UI yerine MT5'ten taze gelir.
// ForexFactory haftalik ekonomik takvim cekme (JSON formati).
// Cache: 1 saat (CF Workers tarafindan da cache'lenmis olabilir, biz de tekrar cache'liyoruz).
let _ffCache = { ts: 0, data: null };
const FF_TTL_MS = 60 * 60 * 1000;
async function handleNewsCalendar(_req, res) {
  const startedAt = Date.now();
  try {
    if (_ffCache.data && (Date.now() - _ffCache.ts) < FF_TTL_MS) {
      writeJson(res, 200, { ok: true, cached: true, events: _ffCache.data });
      return;
    }
    // ForexFactory haftalık JSON: nffx weekly endpoint
    const url = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
    const resp = await new Promise((resolve, reject) => {
      const req2 = https.get(url, { timeout: 10000 }, r => {
        let chunks = '';
        r.on('data', c => chunks += c.toString());
        r.on('end', () => resolve({ status: r.statusCode || 0, body: chunks }));
      });
      req2.on('error', reject);
      req2.on('timeout', () => { req2.destroy(new Error('ff_timeout')); });
    });
    if (resp.status < 200 || resp.status >= 300) {
      writeJson(res, 502, { ok: false, error: 'ff_http_error', status: resp.status });
      return;
    }
    let arr = [];
    try { arr = JSON.parse(resp.body); } catch (e) {
      writeJson(res, 502, { ok: false, error: 'ff_parse_failed', detail: e.message });
      return;
    }
    if (!Array.isArray(arr)) {
      writeJson(res, 502, { ok: false, error: 'ff_invalid_format' });
      return;
    }
    // Yuksek/orta etkili haberleri filtrele, gelecek 7 gun
    const now = Date.now();
    const future = now + 7 * 24 * 3600 * 1000;
    const filtered = arr.filter(e => {
      const t = Date.parse(e.date || '');
      if (!Number.isFinite(t)) return false;
      if (t < now - 3600000) return false; // 1 saat geçmişi de tut
      if (t > future) return false;
      const imp = String(e.impact || '').toLowerCase();
      return imp === 'high' || imp === 'medium';
    }).map(e => ({
      title: String(e.title || '').slice(0, 200),
      country: String(e.country || ''),
      impact: String(e.impact || '').toLowerCase(),
      date: e.date || '',
      ts: Date.parse(e.date || ''),
      forecast: e.forecast || '',
      previous: e.previous || ''
    }));
    _ffCache = { ts: Date.now(), data: filtered };
    writeJson(res, 200, { ok: true, cached: false, count: filtered.length, events: filtered });
    logEvent('info', 'news_calendar.ok', { count: filtered.length, elapsed_ms: Date.now() - startedAt });
  } catch (err) {
    logEvent('error', 'news_calendar.failed', { detail: err.message, elapsed_ms: Date.now() - startedAt });
    writeJson(res, 500, { ok: false, error: 'news_calendar_failed', detail: err.message });
  }
}

async function handleAccountInfo(_req, res) {
  const startedAt = Date.now();
  try {
    const pyCode = [
      'import json',
      'import MetaTrader5 as mt5',
      ...PY_MT5_BOOT_LINES,
      pyMt5IfNotInitLine(),
      '  print(json.dumps({"ok":False,"error":"mt5_init_failed","detail":str(mt5.last_error())}), flush=True)',
      '  raise SystemExit(0)',
      'ai = mt5.account_info()',
      'if ai is None:',
      '  mt5.shutdown()',
      '  print(json.dumps({"ok":False,"error":"no_account_info"}), flush=True)',
      '  raise SystemExit(0)',
      'out = {',
      '  "ok": True,',
      '  "login": int(getattr(ai,"login",0) or 0),',
      '  "name": str(getattr(ai,"name","") or ""),',
      '  "server": str(getattr(ai,"server","") or ""),',
      '  "currency": str(getattr(ai,"currency","USD") or "USD"),',
      '  "leverage": int(getattr(ai,"leverage",100) or 100),',
      '  "balance": float(getattr(ai,"balance",0) or 0),',
      '  "equity": float(getattr(ai,"equity",0) or 0),',
      '  "profit": float(getattr(ai,"profit",0) or 0),',
      '  "margin": float(getattr(ai,"margin",0) or 0),',
      '  "margin_free": float(getattr(ai,"margin_free",0) or 0),',
      '  "margin_level": float(getattr(ai,"margin_level",0) or 0),',
      '  "trade_mode": ("demo" if int(getattr(ai,"trade_mode",-1))==0 else ("real" if int(getattr(ai,"trade_mode",-1))==2 else "unknown"))',
      '}',
      'mt5.shutdown()',
      'print(json.dumps(out), flush=True)'
    ].join('\n');
    const { stdout } = await pyExec(pyCode);
    const j = JSON.parse((stdout || '').trim() || '{}');
    writeJson(res, 200, j);
    logEvent('info', 'account_info.ok', { balance: j.balance, equity: j.equity, margin_level: j.margin_level, elapsed_ms: Date.now() - startedAt });
  } catch (err) {
    logEvent('error', 'account_info.failed', { detail: err.message, elapsed_ms: Date.now() - startedAt });
    writeJson(res, 500, { ok: false, error: 'account_info_failed', detail: err.message });
  }
}

function pyMt5InitLine() {
  if (MT5_LOGIN_ENV && MT5_PASSWORD_ENV && MT5_SERVER_ENV) {
    return `_crt_mt5_init(${Number(MT5_LOGIN_ENV)}, ${JSON.stringify(MT5_PASSWORD_ENV)}, ${JSON.stringify(MT5_SERVER_ENV)})`;
  }
  return '_crt_mt5_init()';
}
function pyMt5IfNotInitLine() {
  return `if not ${pyMt5InitLine()}:`;
}

function handlePing(_req, res) {
  writeJson(res, 200, {
    ok: true,
    service: 'forex-scanner-proxy',
    port: PORT,
    ts: Date.now()
  });
}

async function handleHealth(_req, res) {
  const startedAt = Date.now();
  try {
    const pyCode = [
      'import json',
      'import MetaTrader5 as mt5',
      ...PY_MT5_BOOT_LINES,
      `ok = ${pyMt5InitLine()}`,
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
      ...PY_MT5_BOOT_LINES,
      pyMt5IfNotInitLine(),
      '  print(json.dumps({"ok": False, "error":"mt5_initialize_failed", "detail": str(mt5.last_error())}), flush=True)',
      '  raise SystemExit(0)',
      'ai = mt5.account_info()',
      'acc_login = int(getattr(ai, "login", 0) or 0) if ai is not None else 0',
      'acc_mode_int = int(getattr(ai, "trade_mode", -1) or -1) if ai is not None else -1',
      'acc_mode = "demo" if acc_mode_int == 0 else ("real" if acc_mode_int == 2 else "unknown")',
      '# MT5 history_deals_get/orders_get expect NAIVE datetime in broker server time, not UTC.',
      '# Using datetime.now() (naive local) + 1-day buffer on each side handles brokers on GMT+0..GMT+5 reliably.',
      'now = datetime.datetime.now()',
      'from_dt = now - datetime.timedelta(days=7)',
      'to_dt = now + datetime.timedelta(days=1)',
      'open_positions = mt5.positions_get() or []',
      'open_rows = []',
      'for p in open_positions:',
      '  side = "LONG" if int(getattr(p, "type", -1)) == mt5.POSITION_TYPE_BUY else "SHORT"',
      '  comment = str(getattr(p, "comment", "") or "")',
      '  lc = comment.lower()',
      '  strategy_tag = "core"',
      '  if "turtle" in lc: strategy_tag = "turtle_sopa"',
      '  elif "vwap" in lc: strategy_tag = "vwap_reclaim"',
      '  elif "ict" in lc or "liquidity" in lc: strategy_tag = "ict_liquidity"',
      '  elif "lat" in lc: strategy_tag = "lat_flash"',
      '  elif "sr_break" in lc or "sr-" in lc: strategy_tag = "sr_breakout"',
      '  elif comment.startswith("TG334") or int(getattr(p,"magic",0) or 0)==334001: strategy_tag = "trendgrid334"',
      '  open_rows.append({"ticket": int(getattr(p, "ticket", 0) or 0), "symbol": str(getattr(p, "symbol", "") or ""), "side": side, "volume": float(getattr(p, "volume", 0) or 0), "price_open": float(getattr(p, "price_open", 0) or 0), "sl": float(getattr(p, "sl", 0) or 0), "tp": float(getattr(p, "tp", 0) or 0), "profit": float(getattr(p, "profit", 0) or 0), "time": int(getattr(p, "time", 0) or 0), "comment": comment, "strategy_tag": strategy_tag, "magic": int(getattr(p,"magic",0) or 0)})',
      'deals = mt5.history_deals_get(from_dt, to_dt) or []',
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
      '  elif "ict" in lc or "liquidity" in lc: strategy_tag = "ict_liquidity"',
      '  elif "lat" in lc: strategy_tag = "lat_flash"',
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
      '  elif "ict" in lc or "liquidity" in lc: strategy_tag = "ict_liquidity"',
      '  elif "lat" in lc: strategy_tag = "lat_flash"',
      '  elif comment.startswith("TG334") or int(getattr(o,"magic",0) or 0)==334001: strategy_tag = "trendgrid334"',
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
      '    "strategy_tag": strategy_tag,',
      '    "magic": int(getattr(o,"magic",0) or 0)',
      '  })',
      'mt5.shutdown()',
      'print(json.dumps({"ok": True, "account_login": acc_login, "account_mode": acc_mode, "open_positions": open_rows, "closed_deals": closed_rows, "pending_orders": pending_rows}), flush=True)'
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
    const payload = normalizeManagePayload(JSON.parse(body || '{}'));
    saveManageCfg(payload);
    const tp1R = Math.max(0.2, Number(payload.tp1_rr || 1.0));
    const beAtR = Math.max(0.2, Number(payload.be_at_r || 1.0));
    const trailAtR = Math.max(0.2, Number(payload.trail_at_r || 1.5));
    const partialClosePct = Math.max(0, Math.min(100, Number(payload.partial_close_pct || 50)));
    const earlyManageUsd = Math.max(0, Number(payload.early_manage_usd || 0));
    const trailActivateUsd = Math.max(0, Number(payload.trail_activate_usd || 0));
    const trailTargetUsd = Math.max(0, Number(payload.trail_target_usd || 0));
    const trailPullbackUsd = Math.max(0, Number(payload.trail_pullback_usd || 5));
    const lockSlUntilUsdTp = !!payload.lock_sl_until_usd_tp;
    const slUsdMax = Math.max(0, Number(payload.sl_usd_max || 0));
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
      ...PY_MT5_BOOT_LINES,
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
      'trail_activate_usd=float(p.get("trail_activate_usd",0) or 0)',
      'trail_target_usd=float(p.get("trail_target_usd",0) or 0)',
      'trail_pullback_usd=float(p.get("trail_pullback_usd",5) or 5)',
      'lock_sl_until_usd_tp=bool(p.get("lock_sl_until_usd_tp",False))',
      'sl_usd_max=float(p.get("sl_usd_max",0) or 0)',
      'portfolio_tp_usd=float(p.get("portfolio_tp_usd",0) or 0)',
      'portfolio_sl_usd=float(p.get("portfolio_sl_usd",0) or 0)',
      'portfolio_be_usd=float(p.get("portfolio_be_usd",0) or 0)',
      'portfolio_trail_activate_usd=float(p.get("portfolio_trail_activate_usd",0) or 0)',
      'portfolio_trail_drawdown_usd=float(p.get("portfolio_trail_drawdown_usd",0) or 0)',
      'cur.execute("""CREATE TABLE IF NOT EXISTS portfolio_state (id INTEGER PRIMARY KEY, peak_profit REAL DEFAULT 0, trail_armed INTEGER DEFAULT 0, updated_at TEXT)""")',
      pyMt5IfNotInitLine(),
      '  out={"ok":False,"error":"mt5_initialize_failed","detail":str(mt5.last_error())}',
      '  conn.close()',
      '  print(json.dumps(out), flush=True)',
      '  raise SystemExit(0)',
      'positions=mt5.positions_get() or []',
      ...PY_TG334_SKIP_LINES,
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
      '  if is_tg334_owned(pos): continue',
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
      '  digits=int(getattr(si,"digits",5) or 5)',
      '  stops_level_pts=float(getattr(si,"trade_stops_level",0) or 0)',
      '  min_dist=stops_level_pts*point if point>0 else 0.0',
      '  # Hizli USD TP: entryye yakin broker TP (~$2). Uzak strateji TP varsa yeniden ayarla.',
      '  if lock_sl_until_usd_tp and trail_target_usd>0.0 and sl>0 and volume>0:',
      '    ot=mt5.ORDER_TYPE_BUY if side=="LONG" else mt5.ORDER_TYPE_SELL',
      '    entry_ref=round(float(entry), digits)',
      '    buf=max(min_dist, point*2)',
      '    risk_ref=max(abs(entry-sl), buf, point*10)',
      '    max_dist=max(risk_ref*3.0, buf*20, point*500)',
      '    def _usd_tp_profit(px):',
      '      return float(mt5.order_calc_profit(ot, symbol, volume, entry_ref, round(px, digits)) or 0)',
      '    cur_est=_usd_tp_profit(tp) if tp>0 else 0.0',
      '    need_usd_tp=(tp<=0) or (cur_est>trail_target_usd*1.15) or (cur_est<trail_target_usd*0.85)',
      '    if need_usd_tp:',
      '      new_tp=0.0',
      '      if side=="LONG":',
      '        lo=entry_ref+buf; hi=entry_ref+max_dist',
      '        for _ in range(48):',
      '          mid=round((lo+hi)/2, digits)',
      '          if _usd_tp_profit(mid)<trail_target_usd: lo=mid',
      '          else: hi=mid',
      '        new_tp=round(hi, digits)',
      '      else:',
      '        hi=entry_ref-buf; lo=max(point, entry_ref-max_dist)',
      '        for _ in range(48):',
      '          mid=round((lo+hi)/2, digits)',
      '          if _usd_tp_profit(mid)<trail_target_usd: hi=mid',
      '          else: lo=mid',
      '        new_tp=round(lo, digits)',
      '      est=_usd_tp_profit(new_tp) if new_tp>0 else 0.0',
      '      tp_ok=(side=="LONG" and new_tp>px+point) or (side=="SHORT" and new_tp<px-point)',
      '      if tp>0 and abs(float(tp)-float(new_tp))<=point*2 and cur_est>=trail_target_usd*0.85:',
      '        pass',
      '      elif new_tp>0 and est>=trail_target_usd*0.85 and tp_ok:',
      '        req={"action":mt5.TRADE_ACTION_SLTP,"position":ticket,"symbol":symbol,"sl":float(sl),"tp":float(new_tp),"magic":20260506,"comment":"crt-tp-usd-price"}',
      '        rr=mt5.order_send(req)',
      '        rc=int(getattr(rr,"retcode",0) or 0)',
      '        ok=bool(rr and rc in (mt5.TRADE_RETCODE_DONE,mt5.TRADE_RETCODE_PLACED,10025))',
      '        if ok or rc not in (10027,10004):',
      '          actions.append({"ticket":ticket,"symbol":symbol,"side":side,"type":"tp_usd_set","ok":ok,"retcode":rc,"new_tp":float(new_tp),"profit_est_usd":float(est),"target_usd":float(trail_target_usd),"old_tp":float(tp),"old_est_usd":float(cur_est)})',
      '        if ok and rc!=10025:',
      '          tp=float(new_tp)',
      '  # Max USD zarar: SL $8 uzerindeyse broker SLTP ile sinirla',
      '  if lock_sl_until_usd_tp and sl_usd_max>0.0 and sl>0 and volume>0:',
      '    ot=mt5.ORDER_TYPE_BUY if side=="LONG" else mt5.ORDER_TYPE_SELL',
      '    entry_ref=round(float(entry), digits)',
      '    buf=max(min_dist, point*2)',
      '    risk_ref=max(abs(entry-sl), buf, point*10)',
      '    max_dist=max(risk_ref*3.0, buf*20, point*500)',
      '    def _usd_sl_loss(px):',
      '      pr=float(mt5.order_calc_profit(ot, symbol, volume, entry_ref, round(px, digits)) or 0)',
      '      return (-pr) if pr<0 else 0.0',
      '    cur_sl_loss=_usd_sl_loss(sl)',
      '    if cur_sl_loss>sl_usd_max+0.05:',
      '      strat_sl=float(sl)',
      '      if side=="LONG":',
      '        hi=entry_ref-buf; lo=max(point, entry_ref-max_dist)',
      '        for _ in range(48):',
      '          mid=round((lo+hi)/2, digits)',
      '          if _usd_sl_loss(mid)>sl_usd_max: lo=mid',
      '          else: hi=mid',
      '        new_sl=round(hi, digits)',
      '        new_sl=float(max(strat_sl, new_sl))',
      '      else:',
      '        lo=entry_ref+buf; hi=entry_ref+max_dist',
      '        for _ in range(48):',
      '          mid=round((lo+hi)/2, digits)',
      '          if _usd_sl_loss(mid)>sl_usd_max: hi=mid',
      '          else: lo=mid',
      '        new_sl=round(lo, digits)',
      '        new_sl=float(min(strat_sl, new_sl))',
      '      if abs(float(new_sl)-float(sl))>point*2:',
      '        req={"action":mt5.TRADE_ACTION_SLTP,"position":ticket,"symbol":symbol,"sl":float(new_sl),"tp":float(tp),"magic":20260506,"comment":"crt-sl-usd-cap"}',
      '        rr=mt5.order_send(req)',
      '        rc=int(getattr(rr,"retcode",0) or 0)',
      '        ok=bool(rr and rc in (mt5.TRADE_RETCODE_DONE,mt5.TRADE_RETCODE_PLACED,10025))',
      '        if ok or rc not in (10027,10004):',
      '          actions.append({"ticket":ticket,"symbol":symbol,"side":side,"type":"sl_usd_cap","ok":ok,"retcode":rc,"new_sl":float(new_sl),"loss_est_usd":float(_usd_sl_loss(new_sl)),"target_usd":float(sl_usd_max),"old_sl":float(sl),"old_loss_usd":float(cur_sl_loss)})',
      '        if ok and rc!=10025:',
      '          sl=float(new_sl)',
      '  # SL/TP atanmamissa sahiplen (adoption) — hizli USD TP modunda tp=0 kasitli, adopt spam yapma',
      '  needs_adoption = (sl<=0) or (tp<=0 and not (lock_sl_until_usd_tp and trail_target_usd>0.0))',
      '  if needs_adoption:',
      '    lv=adopt_levels(symbol, side, entry, point)',
      '    if lv is not None:',
      '      new_sl = lv["sl"] if sl<=0 else sl',
      '      new_tp = 0.0 if (lock_sl_until_usd_tp and trail_target_usd>0.0) else (lv["tp"] if tp<=0 else tp)',
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
      '  profit_usd=float(getattr(pos,"profit",0) or 0)',
      '  try:',
      '    cur.execute("ALTER TABLE manage_state ADD COLUMN peak_profit_usd REAL DEFAULT 0")',
      '  except Exception:',
      '    pass',
      '  mrow=cur.execute("SELECT tp1_done, COALESCE(peak_profit_usd,0) FROM manage_state WHERE position_ticket=?",(ticket,)).fetchone()',
      '  tp1_done=int(mrow[0]) if mrow else 0',
      '  peak_usd=float(mrow[1] or 0) if mrow else 0.0',
      '  usd_trail_armed=False',
      '  if trail_target_usd>0.0 and not lock_sl_until_usd_tp and profit_usd>=(trail_target_usd-0.05):',
      '    close_type=mt5.ORDER_TYPE_SELL if side=="LONG" else mt5.ORDER_TYPE_BUY',
      '    close_price=float(tick.bid if close_type==mt5.ORDER_TYPE_SELL else tick.ask)',
      '    req={"action":mt5.TRADE_ACTION_DEAL,"symbol":symbol,"volume":float(volume),"type":close_type,"position":ticket,"price":close_price,"deviation":20,"magic":20260506,"comment":"crt-tp-usd-target","type_time":mt5.ORDER_TIME_GTC,"type_filling":mt5.ORDER_FILLING_IOC}',
      '    rr=mt5.order_send(req)',
      '    ok=bool(rr and rr.retcode in (mt5.TRADE_RETCODE_DONE,mt5.TRADE_RETCODE_PLACED))',
      '    actions.append({"ticket":ticket,"symbol":symbol,"type":"tp_usd_target","ok":ok,"retcode":int(getattr(rr,"retcode",0) or 0),"profit_usd":float(profit_usd),"target_usd":float(trail_target_usd)})',
      '    if ok:',
      '      cur.execute("DELETE FROM manage_state WHERE position_ticket=?",(ticket,))',
      '    continue',
      '  if trail_activate_usd>0.0 and profit_usd>=trail_activate_usd:',
      '    usd_trail_armed=True',
      '    peak_usd=max(peak_usd,profit_usd)',
      '  if trail_pullback_usd>0.0 and peak_usd>=trail_activate_usd>0.0 and (peak_usd-profit_usd)>=trail_pullback_usd and profit_usd>0.0:',
      '    close_type=mt5.ORDER_TYPE_SELL if side=="LONG" else mt5.ORDER_TYPE_BUY',
      '    close_price=float(tick.bid if close_type==mt5.ORDER_TYPE_SELL else tick.ask)',
      '    req={"action":mt5.TRADE_ACTION_DEAL,"symbol":symbol,"volume":float(volume),"type":close_type,"position":ticket,"price":close_price,"deviation":20,"magic":20260506,"comment":"crt-tp-usd-trail","type_time":mt5.ORDER_TIME_GTC,"type_filling":mt5.ORDER_FILLING_IOC}',
      '    rr=mt5.order_send(req)',
      '    ok=bool(rr and rr.retcode in (mt5.TRADE_RETCODE_DONE,mt5.TRADE_RETCODE_PLACED))',
      '    actions.append({"ticket":ticket,"symbol":symbol,"type":"tp_usd_trail_pullback","ok":ok,"retcode":int(getattr(rr,"retcode",0) or 0),"profit_usd":float(profit_usd),"peak_usd":float(peak_usd),"pullback_usd":float(trail_pullback_usd)})',
      '    if ok:',
      '      cur.execute("DELETE FROM manage_state WHERE position_ticket=?",(ticket,))',
      '    continue',
      '  risk=abs(entry-sl)',
      '  if sl<=0 or risk<=point*2:',
      '    continue',
      '  r=(px-entry)/risk if side=="LONG" else (entry-px)/risk',
      '  early_hit=(early_manage_usd>0.0 and profit_usd>=early_manage_usd)',
      '  skip_sl_manage=(lock_sl_until_usd_tp and trail_target_usd>0.0 and profit_usd<trail_target_usd)',
      '  if not skip_sl_manage:',
      '    desired_sl=sl',
      '    if r>=be_at_r or early_hit or usd_trail_armed:',
      '      desired_sl=max(desired_sl,entry) if side=="LONG" else (min(desired_sl,entry) if desired_sl>0 else entry)',
      '    if r>=trail_at_r or early_hit or usd_trail_armed:',
      '      if usd_trail_armed and trail_target_usd>trail_activate_usd and profit_usd>=trail_activate_usd:',
      '        prog=min(1.0,(profit_usd-trail_activate_usd)/max(0.01,trail_target_usd-trail_activate_usd))',
      '        trail_mult=0.65-0.35*prog',
      '        trail_dist=risk*max(0.25,trail_mult)',
      '      else:',
      '        trail_dist=risk*0.6',
      '      t_sl=(px-trail_dist) if side=="LONG" else (px+trail_dist)',
      '      desired_sl=max(desired_sl,t_sl) if side=="LONG" else (min(desired_sl,t_sl) if desired_sl>0 else t_sl)',
      '    improve=(desired_sl-sl)>(point*5) if side=="LONG" else ((sl-desired_sl)>(point*5) if sl>0 else True)',
      '    if improve and desired_sl>0:',
      '      req={"action":mt5.TRADE_ACTION_SLTP,"position":ticket,"symbol":symbol,"sl":float(desired_sl),"tp":float(tp),"magic":20260506,"comment":"crt-manage"}',
      '      rr=mt5.order_send(req)',
      '      actions.append({"ticket":ticket,"symbol":symbol,"type":"sl_update","ok":bool(rr and rr.retcode in (mt5.TRADE_RETCODE_DONE,mt5.TRADE_RETCODE_PLACED)),"retcode":int(getattr(rr,"retcode",0) or 0),"new_sl":float(desired_sl),"usd_trail":bool(usd_trail_armed)})',
      '    if (r>=tp1_r or early_hit) and tp1_done==0 and partial_close_pct>0:',
      '      close_vol=max(vol_min, math.floor((volume*(partial_close_pct/100.0))/vol_step)*vol_step)',
      '      if close_vol>=vol_min and close_vol<volume:',
      '        close_type=mt5.ORDER_TYPE_SELL if side=="LONG" else mt5.ORDER_TYPE_BUY',
      '        close_price=float(tick.bid if close_type==mt5.ORDER_TYPE_SELL else tick.ask)',
      '        req={"action":mt5.TRADE_ACTION_DEAL,"symbol":symbol,"volume":float(close_vol),"type":close_type,"position":ticket,"price":close_price,"deviation":20,"magic":20260506,"comment":"crt-tp1-partial","type_time":mt5.ORDER_TIME_GTC,"type_filling":mt5.ORDER_FILLING_IOC}',
      '        rr=mt5.order_send(req)',
      '        ok=bool(rr and rr.retcode in (mt5.TRADE_RETCODE_DONE,mt5.TRADE_RETCODE_PLACED))',
      '        actions.append({"ticket":ticket,"symbol":symbol,"type":"tp1_partial_close","ok":ok,"retcode":int(getattr(rr,"retcode",0) or 0),"closed_volume":float(close_vol)})',
      '        if ok:',
      '          cur.execute("INSERT INTO manage_state(position_ticket,tp1_done,updated_at) VALUES(?,?,?) ON CONFLICT(position_ticket) DO UPDATE SET tp1_done=excluded.tp1_done, updated_at=excluded.updated_at",(ticket,1,datetime.datetime.utcnow().isoformat()))',
      '  cur.execute("INSERT INTO manage_state(position_ticket,tp1_done,peak_profit_usd,updated_at) VALUES(?,?,?,?) ON CONFLICT(position_ticket) DO UPDATE SET tp1_done=excluded.tp1_done, peak_profit_usd=CASE WHEN excluded.peak_profit_usd>COALESCE(manage_state.peak_profit_usd,0) THEN excluded.peak_profit_usd ELSE manage_state.peak_profit_usd END, updated_at=excluded.updated_at",(ticket,tp1_done,float(peak_usd),datetime.datetime.utcnow().isoformat()))',
      '# Bekleyen emirler: uzak strateji TP -> $2 TP (crt-* yorumlu)',
      'if lock_sl_until_usd_tp and trail_target_usd>0.0:',
      '  for po in (mt5.orders_get() or []):',
      '    ticket_o=int(getattr(po,"ticket",0) or 0)',
      '    symbol_o=str(getattr(po,"symbol","") or "")',
      '    if not symbol_o or ticket_o<=0: continue',
      '    comment_o=str(getattr(po,"comment","") or "")',
      '    if not comment_o.startswith("crt-"): continue',
      '    vol_o=float(getattr(po,"volume_initial",0) or getattr(po,"volume_current",0) or 0)',
      '    if vol_o<=0: continue',
      '    side_o="LONG" if int(getattr(po,"type",-1)) in (mt5.ORDER_TYPE_BUY_LIMIT,mt5.ORDER_TYPE_BUY_STOP,mt5.ORDER_TYPE_BUY_STOP_LIMIT) else "SHORT"',
      '    entry_o=float(getattr(po,"price_open",0) or 0)',
      '    sl_o=float(getattr(po,"sl",0) or 0)',
      '    tp_o=float(getattr(po,"tp",0) or 0)',
      '    if entry_o<=0 or sl_o<=0: continue',
      '    si_o=mt5.symbol_info(symbol_o)',
      '    if si_o is None: continue',
      '    pt_o=max(float(getattr(si_o,"point",0.00001) or 0.00001),0.00001)',
      '    dg_o=int(getattr(si_o,"digits",5) or 5)',
      '    st_o=float(getattr(si_o,"trade_stops_level",0) or 0)',
      '    md_o=st_o*pt_o if pt_o>0 else 0.0',
      '    bf_o=max(md_o, pt_o*2)',
      '    ot_o=mt5.ORDER_TYPE_BUY if side_o=="LONG" else mt5.ORDER_TYPE_SELL',
      '    er_o=round(entry_o, dg_o)',
      '    def _po_profit(px):',
      '      return float(mt5.order_calc_profit(ot_o, symbol_o, vol_o, er_o, round(px, dg_o)) or 0)',
      '    ce_o=_po_profit(tp_o) if tp_o>0 else 0.0',
      '    if not ((tp_o<=0) or (ce_o>trail_target_usd*1.15) or (ce_o<trail_target_usd*0.85)): continue',
      '    rr_o=max(abs(entry_o-sl_o), bf_o, pt_o*10)',
      '    mx_o=max(rr_o*3.0, bf_o*20, pt_o*500)',
      '    if side_o=="LONG":',
      '      lo_o=er_o+bf_o; hi_o=er_o+mx_o',
      '      for _ in range(48):',
      '        mid_o=round((lo_o+hi_o)/2, dg_o)',
      '        if _po_profit(mid_o)<trail_target_usd: lo_o=mid_o',
      '        else: hi_o=mid_o',
      '      ntp_o=round(hi_o, dg_o)',
      '    else:',
      '      hi_o=er_o-bf_o; lo_o=max(pt_o, er_o-mx_o)',
      '      for _ in range(48):',
      '        mid_o=round((lo_o+hi_o)/2, dg_o)',
      '        if _po_profit(mid_o)<trail_target_usd: hi_o=mid_o',
      '        else: lo_o=mid_o',
      '      ntp_o=round(lo_o, dg_o)',
      '    est_o=_po_profit(ntp_o) if ntp_o>0 else 0.0',
      '    tick_o=mt5.symbol_info_tick(symbol_o)',
      '    ref_o=float(tick_o.bid if side_o=="LONG" else tick_o.ask) if tick_o else entry_o',
      '    tp_ok_o=(side_o=="LONG" and ntp_o>ref_o+pt_o) or (side_o=="SHORT" and ntp_o<ref_o-pt_o)',
      '    if ntp_o<=0 or est_o<trail_target_usd*0.85 or not tp_ok_o: continue',
      '    if tp_o>0 and abs(float(tp_o)-float(ntp_o))<=pt_o*2 and ce_o>=trail_target_usd*0.85: continue',
      '    req_o={"action":mt5.TRADE_ACTION_MODIFY,"order":ticket_o,"symbol":symbol_o,"price":float(entry_o),"sl":float(sl_o),"tp":float(ntp_o),"magic":int(getattr(po,"magic",20260506) or 20260506)}',
      '    rr2=mt5.order_send(req_o)',
      '    rc2=int(getattr(rr2,"retcode",0) or 0)',
      '    ok2=bool(rr2 and rc2 in (mt5.TRADE_RETCODE_DONE,mt5.TRADE_RETCODE_PLACED,10025))',
      '    if ok2 or rc2 not in (10027,10004):',
      '      actions.append({"ticket":ticket_o,"symbol":symbol_o,"side":side_o,"type":"tp_usd_set_pending","ok":ok2,"retcode":rc2,"new_tp":float(ntp_o),"profit_est_usd":float(est_o),"target_usd":float(trail_target_usd),"old_tp":float(tp_o),"old_est_usd":float(ce_o)})',
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
      '  if is_tg334_owned(pp): continue',
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
    const { stdout } = await pyExec(pyCode, [JSON.stringify({ tp1_rr: tp1R, be_at_r: beAtR, trail_at_r: trailAtR, partial_close_pct: partialClosePct, early_manage_usd: earlyManageUsd, trail_activate_usd: trailActivateUsd, trail_target_usd: trailTargetUsd, trail_pullback_usd: trailPullbackUsd, lock_sl_until_usd_tp: lockSlUntilUsdTp, sl_usd_max: slUsdMax || (lockSlUntilUsdTp ? MAX_SL_USD : 0), portfolio_tp_usd: portfolioTpUsd, portfolio_sl_usd: portfolioSlUsd, portfolio_be_usd: portfolioBeUsd, portfolio_trail_activate_usd: portfolioTrailActivateUsd, portfolio_trail_drawdown_usd: portfolioTrailDrawdownUsd, category_baskets: categoryBaskets, pair_categories: pairCategories }), DB_PATH]);
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

async function handleBacktestLatForex(req, res) {
  const startedAt = Date.now();
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body || '{}');
    const profile = String(payload.profile || 'auto').toLowerCase();
    const isCrypto = profile === 'crypto' || !!payload.auto_crypto;
    const days = Math.max(7, Math.min(1460, Number(payload.days || (isCrypto ? 365 : 90))));
    const tf = String(payload.tf || (isCrypto ? 'M15' : 'M5')).toUpperCase();
    const minConf = Math.max(50, Math.min(95, Number(payload.min_conf || payload.minConf || (isCrypto ? 68 : 65))));
    const autoCrypto = !!payload.auto_crypto;
    const maxSymbols = Math.max(1, Math.min(40, Number(payload.max_symbols || 25)));
    const minTrades = Math.max(1, Number(payload.min_trades || 12));
    const minWr = Number(payload.min_wr || 48);
    const minPf = Number(payload.min_pf || 1.05);
    const saveWhitelist = !!payload.save_whitelist;
    let symbols = [];
    if (Array.isArray(payload.symbols) && payload.symbols.length) {
      symbols = payload.symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean).slice(0, maxSymbols);
    } else if (!autoCrypto && profile !== 'crypto') {
      symbols = ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'NAS100'];
    }
    const scriptPath = path.join(__dirname, 'scripts', 'backtest_lat_forex.py');
    if (!fs.existsSync(scriptPath)) {
      writeJson(res, 404, { ok: false, error: 'backtest_script_missing' });
      return;
    }
    const args = [
      scriptPath,
      '--days', String(days),
      '--tf', tf,
      '--min-conf', String(minConf),
      '--profile', isCrypto ? 'crypto' : profile,
      '--max-symbols', String(maxSymbols),
      '--min-trades', String(minTrades),
      '--min-wr', String(minWr),
      '--min-pf', String(minPf),
      '--compact'
    ];
    if (autoCrypto || (profile === 'crypto' && !symbols.length)) {
      args.push('--auto-crypto');
    } else {
      args.push('--symbols', symbols.join(','));
    }
    if (saveWhitelist) {
      args.push('--out', path.join(__dirname, 'data', 'lat_crypto_whitelist.json'));
    }
    const timeoutMs = isCrypto ? Math.min(600000, 45000 + days * maxSymbols * 80) : 180000;
    const { stdout, stderr } = await execFileAsync(PYTHON_BIN, args, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: pyEnv()
    });
    const j = JSON.parse(String(stdout || '').trim() || '{}');
    if (!j.ok) {
      writeJson(res, 400, { ok: false, error: j.error || 'backtest_failed', detail: j.detail || stderr });
      return;
    }
    logEvent('info', 'backtest_lat_forex.ok', {
      profile: isCrypto ? 'crypto' : profile,
      days,
      tf,
      symbols: Number(j.symbols_tested || symbols.length || 0),
      whitelist: Number(j.summary?.whitelist_count || 0),
      trades: Number(j.summary?.trades || 0),
      elapsed_ms: Date.now() - startedAt
    });
    writeJson(res, 200, j);
  } catch (err) {
    logEvent('error', 'backtest_lat_forex.failed', { detail: err.message, elapsed_ms: Date.now() - startedAt });
    writeJson(res, 500, { ok: false, error: 'backtest_lat_forex_failed', detail: err.message });
  }
}

function handleLatForexWhitelist(_req, res) {
  try {
    const p = path.join(__dirname, 'data', 'lat_forex_whitelist.json');
    if (!fs.existsSync(p)) {
      writeJson(res, 200, { ok: true, whitelist: [], symbols: [], summary: null });
      return;
    }
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    writeJson(res, 200, { ok: true, ...j });
  } catch (err) {
    writeJson(res, 500, { ok: false, error: 'lat_forex_whitelist_read_failed', detail: err.message });
  }
}

function handleLatCryptoWhitelist(_req, res) {
  try {
    const p = path.join(__dirname, 'data', 'lat_crypto_whitelist.json');
    if (!fs.existsSync(p)) {
      writeJson(res, 200, { ok: true, whitelist: [], symbols: [], summary: null });
      return;
    }
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    writeJson(res, 200, { ok: true, ...j });
  } catch (err) {
    writeJson(res, 500, { ok: false, error: 'lat_whitelist_read_failed', detail: err.message });
  }
}

// Telegram bot bildirimi gonder. Frontend bot_token + chat_id ve message ile cagirir.
// Body: {bot_token, chat_id, text, parse_mode?, disable_notification?}
// Bot olusturma: BotFather'da /newbot, token al. Chat ID icin @userinfobot'a /start at.
function postHttps(url, body, headers) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const opts = {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, headers || {}),
        timeout: 8000
      };
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(opts, (resp) => {
        let chunks = '';
        resp.on('data', (c) => { chunks += c.toString(); });
        resp.on('end', () => resolve({ status: resp.statusCode || 0, body: chunks }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('telegram_timeout')); });
      req.write(body);
      req.end();
    } catch (e) { reject(e); }
  });
}

async function handleTelegramNotify(req, res) {
  const startedAt = Date.now();
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body || '{}');
    // GUVENLIK: .env'deki TOKEN/CHAT_ID, frontend gondersе bile onceliklidir (token browser'da olmasa daha guvenli).
    const botToken = String(TELEGRAM_BOT_TOKEN_ENV || payload.bot_token || '').trim();
    const chatId = String(TELEGRAM_CHAT_ID_ENV || payload.chat_id || '').trim();
    const text = String(payload.text || '').trim();
    if (!botToken || !chatId) {
      writeJson(res, 400, { ok: false, error: 'missing_credentials', detail: 'bot_token ve chat_id gerekli' });
      return;
    }
    if (!text) {
      writeJson(res, 400, { ok: false, error: 'missing_text' });
      return;
    }
    const tgUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const reqBody = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: payload.parse_mode || 'HTML',
      disable_notification: !!payload.disable_notification,
      disable_web_page_preview: true
    });
    const resp = await postHttps(tgUrl, reqBody, {});
    let tgJson = {};
    try { tgJson = JSON.parse(resp.body || '{}'); } catch (_) {}
    if (resp.status >= 200 && resp.status < 300 && tgJson && tgJson.ok) {
      writeJson(res, 200, { ok: true, message_id: tgJson.result && tgJson.result.message_id });
      logEvent('info', 'telegram_notify.ok', { elapsed_ms: Date.now() - startedAt, text_len: text.length });
    } else {
      writeJson(res, 502, { ok: false, error: 'telegram_api_error', status: resp.status, detail: tgJson.description || resp.body.slice(0, 200) });
      logEvent('warn', 'telegram_notify.api_error', { status: resp.status, detail: tgJson.description });
    }
  } catch (err) {
    logEvent('error', 'telegram_notify.failed', { detail: err.message, elapsed_ms: Date.now() - startedAt });
    writeJson(res, 500, { ok: false, error: 'telegram_notify_failed', detail: err.message });
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

async function handleTrendGrid334Guard(req, res) {
  try {
    if (req.method === 'GET') {
      writeJson(res, 200, { ok: true, ...loadTrendGrid334Guard() });
      return;
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const saved = saveTrendGrid334Guard(payload);
      logEvent('info', 'trendgrid334_guard.updated', { active: saved.active, symbol: saved.symbol });
      writeJson(res, 200, { ok: true, ...saved });
      return;
    }
    writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
  } catch (err) {
    writeJson(res, 500, { ok: false, error: 'trendgrid334_guard_failed', detail: err.message });
  }
}

function handlePlanCfgProduction(req, res) {
  try {
    if (req.method !== 'GET') {
      writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }
    writeJson(res, 200, { ok: true, ...loadPlanCfgProduction() });
  } catch (err) {
    writeJson(res, 500, { ok: false, error: 'plan_cfg_production_failed', detail: err.message });
  }
}

async function handleExecuteOrder(req, res) {
  const startedAt = Date.now();
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body || '{}');
    const execSymbol = String(payload.symbol || '').trim().toUpperCase();
    if (isTrendGrid334ExclusiveSymbol(execSymbol)) {
      logEvent('warn', 'execute_order.trendgrid334_blocked', { symbol: execSymbol });
      writeJson(res, 403, {
        ok: false,
        error: 'trendgrid334_ea_exclusive',
        detail: `${execSymbol} TrendGrid334 EA tarafindan yonetiliyor. Dashboard emirleri bu paritede kapali.`
      });
      return;
    }
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
      ...PY_MT5_BOOT_LINES,
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
      'if strategy_tag not in ("core","turtle_sopa","vwap_reclaim","sr_breakout","lat_flash","ict_liquidity"): strategy_tag = "core"',
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
      '  ok_init = _crt_mt5_init(meta_login, meta_password, meta_server)',
      'else:',
      '  ok_init = _crt_mt5_init()',
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
      '# Hizli USD TP: broker TP fiyatini order_calc_profit ile hedef USD kari verecek sekilde ayarla',
      'lock_sl_until_usd_tp=bool(p.get("lock_sl_until_usd_tp", False))',
      'tp_usd_target=float(p.get("tp_usd_target",0) or 0)',
      'if tp_usd_target<=0 and lock_sl_until_usd_tp:',
      '  tp_usd_target=max(0.0, float(os.environ.get("CRT_QUICK_TP_USD","2") or 2))',
      'tp_profit_est=0.0',
      'if tp_usd_target>0 and lot>0:',
      '  tp=0.0',
      '  ot=mt5.ORDER_TYPE_BUY if side=="LONG" else mt5.ORDER_TYPE_SELL',
      '  entry_ref=round(float(final_price), digits)',
      '  def _tp_profit(px):',
      '    return float(mt5.order_calc_profit(ot, symbol, lot, entry_ref, round(px, digits)) or 0)',
      '  buf=max(min_dist, point*2)',
      '  risk_ref=max(abs(entry_ref-float(sl)), buf, point*10) if float(sl)>0 else max(buf*10, point*500)',
      '  max_dist=max(risk_ref*3.0, buf*20, point*500)',
      '  if side=="LONG":',
      '    lo=entry_ref+buf; hi=entry_ref+max_dist',
      '    for _ in range(48):',
      '      mid=round((lo+hi)/2, digits)',
      '      if _tp_profit(mid)<tp_usd_target: lo=mid',
      '      else: hi=mid',
      '    tp=round(hi, digits)',
      '  else:',
      '    hi=entry_ref-buf; lo=max(point, entry_ref-max_dist)',
      '    for _ in range(48):',
      '      mid=round((lo+hi)/2, digits)',
      '      if _tp_profit(mid)<tp_usd_target: hi=mid',
      '      else: lo=mid',
      '    tp=round(lo, digits)',
      '  tp_profit_est=_tp_profit(tp)',
      '# Max USD zarar: strateji SL $8 uzerindeyse broker order_calc_profit ile sinirla',
      'sl_usd_max=float(p.get("sl_usd_max",0) or 0)',
      'if sl_usd_max<=0 and lock_sl_until_usd_tp:',
      '  sl_usd_max=max(0.0, float(os.environ.get("CRT_MAX_SL_USD","8") or 8))',
      'sl_loss_est=0.0',
      'if sl_usd_max>0 and lot>0:',
      '  ot_sl=mt5.ORDER_TYPE_BUY if side=="LONG" else mt5.ORDER_TYPE_SELL',
      '  entry_ref_sl=round(float(final_price), digits)',
      '  buf_sl=max(min_dist, point*2)',
      '  risk_ref_sl=max(abs(entry_ref_sl-float(sl)), buf_sl, point*10) if float(sl)>0 else max(buf_sl*10, point*500)',
      '  max_dist_sl=max(risk_ref_sl*3.0, buf_sl*20, point*500)',
      '  def _sl_loss(px):',
      '    pr=float(mt5.order_calc_profit(ot_sl, symbol, lot, entry_ref_sl, round(px, digits)) or 0)',
      '    return (-pr) if pr<0 else 0.0',
      '  strat_sl=float(sl)',
      '  cur_loss=_sl_loss(strat_sl) if strat_sl>0 else (sl_usd_max+1.0)',
      '  if strat_sl<=0 or cur_loss>sl_usd_max+0.05:',
      '    if side=="LONG":',
      '      hi=entry_ref_sl-buf_sl; lo=max(point, entry_ref_sl-max_dist_sl)',
      '      for _ in range(48):',
      '        mid=round((lo+hi)/2, digits)',
      '        if _sl_loss(mid)>sl_usd_max: lo=mid',
      '        else: hi=mid',
      '      sl_at_max=round(hi, digits)',
      '      sl=float(max(strat_sl, sl_at_max) if strat_sl>0 else sl_at_max)',
      '    else:',
      '      lo=entry_ref_sl+buf_sl; hi=entry_ref_sl+max_dist_sl',
      '      for _ in range(48):',
      '        mid=round((lo+hi)/2, digits)',
      '        if _sl_loss(mid)>sl_usd_max: hi=mid',
      '        else: lo=mid',
      '      sl_at_max=round(lo, digits)',
      '      sl=float(min(strat_sl, sl_at_max) if strat_sl>0 else sl_at_max)',
      '  sl_loss_est=_sl_loss(float(sl)) if float(sl)>0 else 0.0',
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
    // GUVENLIK: .env'de MT5 credentials varsa frontend'den gelen plaintext sifre/login'i override et.
    // Bu sayede browser localStorage'da sifre tutulmasa bile MT5 login calisir.
    const securedPayload = { ...payload };
    if (MT5_LOGIN_ENV) securedPayload.meta_login = Number(MT5_LOGIN_ENV) || 0;
    if (MT5_PASSWORD_ENV) securedPayload.meta_password = MT5_PASSWORD_ENV;
    if (MT5_SERVER_ENV) securedPayload.meta_server = MT5_SERVER_ENV;
    const { stdout } = await pyExec(pyCode, [JSON.stringify(securedPayload), DB_PATH]);
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
    if (j.ok && !j.dry_run) {
      try { await mirrorOrderToSecondary(payload, j); } catch (_) { /* ignore */ }
    }
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

  if (PROXY_TOKEN && routePath.startsWith('/api/')) {
    const auth = String(req.headers.authorization || '');
    const xTok = String(req.headers['x-crt-token'] || '');
    const bearer = auth.length > 7 && auth.slice(0, 7).toLowerCase() === 'bearer ' ? auth.slice(7).trim() : '';
    const ok = (bearer && bearer === PROXY_TOKEN) || (xTok && xTok === PROXY_TOKEN);
    if (!ok) {
      writeJson(res, 401, {
        ok: false,
        error: 'unauthorized',
        detail: 'CRT_PROXY_TOKEN tanimli: isteklere Authorization: Bearer <token> veya X-CRT-Token ekleyin.'
      });
      return;
    }
  }

  if (routePath === '/api/crt-analyze' && req.method === 'POST') {
    handleAnalyze(req, res);
    return;
  }
  if (routePath === '/api/broker-candles' && req.method === 'POST') {
    handleBrokerCandles(req, res);
    return;
  }
  if (routePath === '/api/ping' && req.method === 'GET') {
    handlePing(req, res);
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
  if (routePath === '/api/sync-mirror-pending' && req.method === 'POST') {
    handleSyncMirrorPending(req, res);
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
  if (routePath === '/api/trendgrid334-guard' && (req.method === 'GET' || req.method === 'POST')) {
    handleTrendGrid334Guard(req, res);
    return;
  }
  if (routePath === '/api/plan-config-production' && req.method === 'GET') {
    handlePlanCfgProduction(req, res);
    return;
  }
  if (routePath === '/api/reset-portfolio-state' && req.method === 'POST') {
    handleResetPortfolioState(req, res);
    return;
  }
  if (routePath === '/api/telegram-notify' && req.method === 'POST') {
    handleTelegramNotify(req, res);
    return;
  }
  if (routePath === '/api/account-info' && req.method === 'GET') {
    handleAccountInfo(req, res);
    return;
  }
  if (routePath === '/api/news-calendar' && req.method === 'GET') {
    handleNewsCalendar(req, res);
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
  if (routePath === '/api/edges' && req.method === 'GET') {
    try {
      writeJson(res, 200, { ok: true, ...loadEdgesDb() });
    } catch (err) {
      writeJson(res, 500, { ok: false, error: 'edges_load_failed', detail: err.message });
    }
    return;
  }
  if (routePath === '/api/edge-bias' && req.method === 'GET') {
    try {
      const pair = String(parsedUrl.searchParams.get('pair') || '').trim();
      const cat = String(parsedUrl.searchParams.get('cat') || 'forex').trim();
      const bias = edgeEngine.computeEdgeBias(pair, new Date(), loadEdgesDb(), cat);
      writeJson(res, 200, { ok: true, ...bias });
    } catch (err) {
      writeJson(res, 500, { ok: false, error: 'edge_bias_failed', detail: err.message });
    }
    return;
  }
  if (routePath === '/api/backtest-lat-forex' && req.method === 'POST') {
    handleBacktestLatForex(req, res);
    return;
  }
  if (routePath === '/api/lat-forex-whitelist' && req.method === 'GET') {
    handleLatForexWhitelist(req, res);
    return;
  }
  if (routePath === '/api/lat-crypto-whitelist' && req.method === 'GET') {
    handleLatCryptoWhitelist(req, res);
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

  // === STATIC FILE SERVING (dashboard + assets) ===
  // GET / -> dashboard
  // GET /<file> -> proje root'undan dosya (sadece beyaz listedeki uzantilar)
  if (req.method === 'GET' && !routePath.startsWith('/api/')) {
    try {
      let filePath = routePath === '/' ? '/crt_signals_v3.html' : routePath;
      // path traversal koruma
      const cleanPath = path.normalize(filePath).replace(/^(\.\.[\\\/])+/, '');
      const absPath = path.join(__dirname, cleanPath);
      if (!absPath.startsWith(__dirname)) {
        writeJson(res, 403, { error: 'forbidden' });
        return;
      }
      if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
        writeJson(res, 404, { error: 'file_not_found', path: cleanPath });
        return;
      }
      const ext = path.extname(absPath).toLowerCase();
      const allowed = {
        '.html': 'text/html; charset=utf-8',
        '.htm':  'text/html; charset=utf-8',
        '.js':   'application/javascript; charset=utf-8',
        '.mjs':  'application/javascript; charset=utf-8',
        '.css':  'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg':  'image/svg+xml',
        '.png':  'image/png',
        '.jpg':  'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif':  'image/gif',
        '.ico':  'image/x-icon',
        '.woff': 'font/woff',
        '.woff2':'font/woff2',
        '.txt':  'text/plain; charset=utf-8',
        '.map':  'application/json; charset=utf-8'
      };
      const ctype = allowed[ext];
      if (!ctype) {
        writeJson(res, 415, { error: 'unsupported_file_type', ext });
        return;
      }
      res.writeHead(200, {
        'Content-Type': ctype,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*'
      });
      fs.createReadStream(absPath).pipe(res);
      return;
    } catch (err) {
      logEvent('error', 'static_serve_failed', { path: routePath, detail: err.message });
      writeJson(res, 500, { error: 'static_serve_error', detail: err.message });
      return;
    }
  }

  logEvent('warn', 'route.not_found', { method: req.method, url: req.url });
  writeJson(res, 404, { error: 'Not found' });
});

let autoManageInFlight = false;
let mirrorSyncInFlight = false;
const mirrorDismissedUntilPrimaryClose = new Set();
const mirrorDismissPending = new Map();
let lastMirrorOpenKeys = new Set();

function bumpMirrorDismissPending(key, reason) {
  const n = (mirrorDismissPending.get(key) || 0) + 1;
  mirrorDismissPending.set(key, n);
  if (n >= MIRROR_DISMISS_TICKS) {
    mirrorDismissedUntilPrimaryClose.add(key);
    mirrorDismissPending.delete(key);
    logEvent('info', 'mirror_dismiss.set', { key, reason, ticks: n });
  }
}

function updateMirrorDismissState(primary, mirror) {
  const primaryOpen = new Set(
    (primary.open_positions || []).filter(isCrtOpenPosition).map((p) => mirrorPendingKey(p.symbol, p.side))
  );
  const currentMirrorOpen = new Set(
    (mirror.open_positions || []).filter(isCrtOpenPosition).map((p) => mirrorPendingKey(p.symbol, p.side))
  );
  for (const key of lastMirrorOpenKeys) {
    if (!currentMirrorOpen.has(key) && primaryOpen.has(key)) {
      bumpMirrorDismissPending(key, 'mirror_closed_primary_still_open');
    }
  }
  const nowSec = Date.now() / 1000;
  for (const p of (primary.open_positions || []).filter(isCrtOpenPosition)) {
    const key = mirrorPendingKey(p.symbol, p.side);
    if (currentMirrorOpen.has(key) || mirrorDismissedUntilPrimaryClose.has(key)) continue;
    const recentMirrorClose = (mirror.closed_deals || []).some((d) => {
      if (mirrorPendingKey(d.symbol, d.side) !== key) return false;
      const t = Number(d.time || 0);
      return t > 0 && (nowSec - t) < 7200;
    });
    if (recentMirrorClose) bumpMirrorDismissPending(key, 'recent_mirror_tp_while_primary_open');
  }
  for (const key of currentMirrorOpen) mirrorDismissPending.delete(key);
  lastMirrorOpenKeys = currentMirrorOpen;
  for (const key of [...mirrorDismissedUntilPrimaryClose]) {
    if (!primaryOpen.has(key)) mirrorDismissedUntilPrimaryClose.delete(key);
  }
  for (const key of [...mirrorDismissPending.keys()]) {
    if (!primaryOpen.has(key)) mirrorDismissPending.delete(key);
  }
}

function isMirrorDismissed(symbol, side) {
  return mirrorDismissedUntilPrimaryClose.has(mirrorPendingKey(symbol, side));
}

async function mirrorCloseOnSecondary(symbol, side) {
  if (!CRT_MIRROR_ENABLED || Number(PORT) !== 8790) return [];
  const results = [];
  try {
    const mirror = await httpGetJson(CRT_MIRROR_SNAPSHOT_URL);
    const key = mirrorPendingKey(symbol, side);
    for (const p of (mirror.open_positions || [])) {
      if (!isCrtOpenPosition(p) || mirrorPendingKey(p.symbol, p.side) !== key) continue;
      const ticket = Number(p.ticket || 0);
      if (!ticket) continue;
      const cj = await httpPostJson(CRT_MIRROR_CLOSE_URL, { ticket });
      results.push({ type: 'close', ticket, ok: !!cj.ok, detail: cj.detail || '' });
    }
    for (const m of (mirror.pending_orders || [])) {
      if (!isCrtPendingOrder(m) || mirrorPendingKey(m.symbol, m.side) !== key) continue;
      const ticket = Number(m.ticket || 0);
      if (!ticket) continue;
      const cj = await httpPostJson(CRT_MIRROR_CANCEL_URL, { ticket });
      results.push({ type: 'cancel', ticket, ok: !!cj.ok, detail: cj.detail || '' });
    }
  } catch (err) {
    logEvent('warn', 'mirror_close.secondary_failed', { symbol, side, detail: err.message });
  }
  return results;
}
const AUTO_MANAGE_MS = Math.max(2000, Number(process.env.CRT_AUTO_MANAGE_MS || 4000));
const MIRROR_SYNC_MS = Math.max(5000, Number(process.env.CRT_MIRROR_SYNC_MS || 15000));

async function tickMirrorSync() {
  if (!CRT_MIRROR_ENABLED || Number(PORT) !== 8790 || mirrorSyncInFlight) return;
  mirrorSyncInFlight = true;
  try {
    const result = await runMirrorSync();
    const added = (result.actions || []).filter((a) => !a.skipped && !a.action && a.ok);
    const cancelled = (result.actions || []).filter((a) => a.action === 'cancel' && a.ok);
    if (added.length || cancelled.length) {
      logEvent('info', 'mirror_sync.tick', {
        added: added.map((a) => `${a.symbol}:${a.side}`).join(','),
        cancelled: cancelled.map((a) => `${a.symbol}:${a.side}`).join(',')
      });
    }
  } catch (err) {
    logEvent('warn', 'mirror_sync.tick_failed', { detail: err.message });
  } finally {
    mirrorSyncInFlight = false;
  }
}

async function tickAutoManage() {
  if (autoManageInFlight) return;
  autoManageInFlight = true;
  try {
    const cfg = loadManageCfg();
    if (!(Number(cfg.trail_target_usd || 0) > 0)) return;
    const res = await fetch(`http://127.0.0.1:${PORT}/api/manage-positions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg)
    });
    if (!res.ok) return;
    const j = await res.json();
    const hits = (j.actions || []).filter((a) => a.type === 'tp_usd_target' && a.ok);
    if (hits.length) {
      logEvent('info', 'auto_manage.tp_usd_target', {
        count: hits.length,
        symbols: hits.map((a) => a.symbol).join(','),
        profits: hits.map((a) => a.profit_usd)
      });
    }
  } catch (err) {
    logEvent('warn', 'auto_manage.failed', { detail: err.message });
  } finally {
    autoManageInFlight = false;
  }
}

server.listen(PORT, LISTEN_HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`CRT AI proxy calisiyor: http://${LISTEN_HOST}:${PORT}`);
  logEvent('info', 'server.started', { port: PORT, listen_host: LISTEN_HOST, token_required: !!PROXY_TOKEN, debug_log_path: DEBUG_LOG_PATH });
  saveManageCfg(loadManageCfg());
  if (String(process.env.CRT_AUTO_MANAGE || 'true').toLowerCase() !== 'false') {
    setInterval(tickAutoManage, AUTO_MANAGE_MS);
    logEvent('info', 'auto_manage.started', { interval_ms: AUTO_MANAGE_MS, trail_target_usd: loadManageCfg().trail_target_usd });
  }
  if (CRT_MIRROR_ENABLED && Number(PORT) === 8790) {
    setInterval(tickMirrorSync, MIRROR_SYNC_MS);
    logEvent('info', 'mirror_sync.started', { interval_ms: MIRROR_SYNC_MS });
    setTimeout(() => { tickMirrorSync().catch(() => {}); }, 3000);
  }
});
