#!/usr/bin/env python3
"""LAT flash backtest on MT5 history — forex, metals, indices, crypto (CRT + FK calibrated)."""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

MAJOR_FX = frozenset({"EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD"})
CRYPTO_MAJOR = frozenset({"BTCUSD", "ETHUSD", "BTCUSDT", "ETHUSDT"})
CRYPTO_TAGS = (
    "BTC", "ETH", "XRP", "LTC", "DOGE", "ADA", "SOL", "DOT", "BNB", "AVAX",
    "LINK", "MATIC", "SHIB", "TRX", "UNI", "XLM", "ATOM", "BCH", "NEAR", "APT",
    "OP", "ARB", "SUI", "FIL", "INJ", "TIA", "WLD", "PEPE", "SHIB",
)


def derive_category(symbol: str) -> str:
    s = (symbol or "").upper().replace("/", "")
    if s in MAJOR_FX or (len(s) == 6 and s.isalpha() and not any(t in s for t in CRYPTO_TAGS)):
        return "forex"
    if any(t in s for t in ("XAU", "XAG", "XPT", "XPD", "GOLD", "SILVER")):
        return "metals"
    if any(t in s for t in ("NAS100", "US100", "US30", "US500", "SPX500", "GER40", "GER30", "DE40", "UK100", "CAC40", "DJ30")):
        return "indices"
    if any(t in s for t in CRYPTO_TAGS):
        return "crypto"
    if len(s) == 6:
        return "forex"
    return "other"


def lat_params(symbol: str, profile: str = "auto") -> dict:
    cat = derive_category(symbol)
    s = symbol.upper()
    base = {"tp_fib": 0.618, "sl_fib": 0.50, "min_conf": 65}
    if profile == "crypto" or cat == "crypto":
        if s in CRYPTO_MAJOR or s.startswith("BTC") or s.startswith("ETH"):
            return {**base, "min_conf": 68, "price_threshold": 0.72, "vol_mult": 2.9, "rsi_long": 24, "rsi_short": 76, "window": 45}
        return {**base, "min_conf": 70, "price_threshold": 0.55, "vol_mult": 3.2, "rsi_long": 25, "rsi_short": 75, "window": 35}
    if "XAU" in s or "GOLD" in s:
        return {**base, "price_threshold": 0.38, "vol_mult": 2.4, "rsi_long": 26, "rsi_short": 74, "window": 40}
    if cat == "metals":
        return {**base, "price_threshold": 0.32, "vol_mult": 2.6, "rsi_long": 28, "rsi_short": 72, "window": 45}
    if cat == "indices":
        return {**base, "price_threshold": 0.42, "vol_mult": 2.2, "rsi_long": 30, "rsi_short": 70, "window": 35}
    if cat == "forex" and s in MAJOR_FX:
        return {**base, "price_threshold": 0.22, "vol_mult": 2.8, "rsi_long": 28, "rsi_short": 72, "window": 45}
    if cat == "forex":
        return {**base, "price_threshold": 0.28, "vol_mult": 3.0, "rsi_long": 27, "rsi_short": 73, "window": 50}
    return {**base, "price_threshold": 0.30, "vol_mult": 2.8, "rsi_long": 28, "rsi_short": 72, "window": 45}


def discover_crypto_symbols(mt5, max_n: int = 30) -> list[str]:
    found: list[str] = []
    for sym in mt5.symbols_get() or []:
        name = str(getattr(sym, "name", "") or "").upper()
        if not name or not getattr(sym, "visible", True):
            continue
        path = str(getattr(sym, "path", "") or "").lower()
        desc = str(getattr(sym, "description", "") or "").lower()
        is_crypto = "crypto" in path or "cryptocurrency" in desc or any(t in name for t in CRYPTO_TAGS)
        if not is_crypto:
            continue
        if not (name.endswith("USD") or name.endswith("USDT")):
            continue
        found.append(name)
    # Prefer major liquid first
    priority = []
    rest = []
    for n in sorted(set(found)):
        if n in CRYPTO_MAJOR or n.startswith("BTC") or n.startswith("ETH"):
            priority.append(n)
        else:
            rest.append(n)
    out = (priority + rest)[:max_n]
    return out


def compute_rsi(closes: list[float], period: int = 14) -> list[float | None]:
    out: list[float | None] = [None] * len(closes)
    if len(closes) < period + 2:
        return out
    gains = losses = 0.0
    for i in range(1, period + 1):
        d = closes[i] - closes[i - 1]
        if d >= 0:
            gains += d
        else:
            losses -= d
    avg_g, avg_l = gains / period, losses / period
    out[period] = 100.0 if avg_l == 0 else 100.0 - (100.0 / (1.0 + avg_g / avg_l))
    for i in range(period + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        g, l = (d, 0.0) if d > 0 else (0.0, -d)
        avg_g = (avg_g * (period - 1) + g) / period
        avg_l = (avg_l * (period - 1) + l) / period
        out[i] = 100.0 if avg_l == 0 else 100.0 - (100.0 / (1.0 + avg_g / avg_l))
    return out


def detect_lat(candles: list[dict], params: dict, min_conf: int) -> dict | None:
    if len(candles) < 200:
        return None
    w = min(int(params["window"]), len(candles) - 1)
    recent = candles[-w:]
    entry = float(recent[-1]["c"])
    price_change = (entry / float(recent[0]["c"]) - 1.0) * 100.0
    vols = [float(c.get("v") or 0) for c in candles]
    avg_vol = sum(vols[-200:]) / 200.0 if vols else 1.0
    cur_vol = sum(float(c.get("v") or 0) for c in recent)
    vol_ratio = cur_vol / avg_vol if avg_vol > 0 else 0.0
    closes = [float(c["c"]) for c in candles]
    rsi = float(compute_rsi(closes, 14)[-1] or 50.0)
    swing = abs(entry * price_change / 100.0) or max(entry * 0.001, 1e-8)
    pt, vm = float(params["price_threshold"]), float(params["vol_mult"])
    tp_f, sl_f = float(params["tp_fib"]), float(params["sl_fib"])
    eff_conf = max(min_conf, int(params.get("min_conf", min_conf)))

    def pack(action: str, sl: float, tp: float, reason: str) -> dict | None:
        risk = abs(entry - sl)
        rew = abs(tp - entry)
        rr = rew / risk if risk > 0 else 0.0
        conf = min(99, int(55 + vol_ratio * 3 + abs(price_change) * 2))
        if conf < eff_conf or rr < 1.1:
            return None
        return {"action": action, "entry": entry, "sl": sl, "tp": tp, "rr": rr, "confidence": conf, "reason": reason}

    if price_change < -pt and vol_ratio > vm and rsi < float(params["rsi_long"]):
        return pack("LONG", entry - swing * sl_f, entry + swing * tp_f,
                    f"flash dump {price_change:.2f}% vol×{vol_ratio:.1f} RSI{rsi:.0f}")
    if price_change > pt and vol_ratio > vm and rsi > float(params["rsi_short"]):
        return pack("SHORT", entry + swing * sl_f, entry - swing * tp_f,
                    f"flash pump +{price_change:.2f}% vol×{vol_ratio:.1f} RSI{rsi:.0f}")
    return None


def simulate_symbol(rates, symbol: str, min_conf: int, profile: str = "auto", compact: bool = True) -> dict:
    params = lat_params(symbol, profile)
    candles = [
        {"t": int(r["time"]), "o": float(r["open"]), "h": float(r["high"]), "l": float(r["low"]),
         "c": float(r["close"]), "v": int(r["tick_volume"]) if "tick_volume" in rates.dtype.names else 0}
        for r in rates
    ]
    trades: list[dict] = []
    open_trade: dict | None = None
    cooldown_until = -1

    for i in range(200, len(candles) - 1):
        bar = candles[i + 1]
        hi, lo = float(bar["h"]), float(bar["l"])
        if open_trade:
            side, sl, tp = open_trade["side"], open_trade["sl"], open_trade["tp"]
            hit = None
            if side == "LONG":
                if lo <= sl:
                    hit = ("loss", sl)
                elif hi >= tp:
                    hit = ("win", tp)
            else:
                if hi >= sl:
                    hit = ("loss", sl)
                elif lo <= tp:
                    hit = ("win", tp)
            if hit:
                kind, px = hit
                entry = open_trade["entry"]
                pnl_pts = (px - entry) if side == "LONG" else (entry - px)
                trades.append({**open_trade, "exit": px, "result": kind, "pnl_pts": pnl_pts, "exit_bar": i + 1})
                open_trade = None
                cooldown_until = i + 12
            continue
        if i < cooldown_until:
            continue
        sig = detect_lat(candles[: i + 1], params, min_conf)
        if not sig:
            continue
        open_trade = {
            "symbol": symbol,
            "side": sig["action"],
            "entry": sig["entry"],
            "sl": sig["sl"],
            "tp": sig["tp"],
            "rr": sig["rr"],
            "confidence": sig["confidence"],
            "reason": sig["reason"],
            "entry_bar": i,
        }

    wins = sum(1 for t in trades if t["result"] == "win")
    losses = len(trades) - wins
    gross_profit = sum(t["pnl_pts"] for t in trades if t["pnl_pts"] > 0)
    gross_loss = abs(sum(t["pnl_pts"] for t in trades if t["pnl_pts"] < 0))
    pf = gross_profit / gross_loss if gross_loss > 0 else (999.0 if gross_profit > 0 else 0.0)
    row = {
        "symbol": symbol,
        "category": derive_category(symbol),
        "trades": len(trades),
        "wins": wins,
        "losses": losses,
        "wr": round(wins / len(trades) * 100, 1) if trades else 0.0,
        "pf": round(min(pf, 999.0), 2),
        "avg_rr": round(sum(t["rr"] for t in trades) / len(trades), 2) if trades else 0.0,
        "params": params,
    }
    if not compact:
        row["sample"] = trades[-5:]
    return row


def passes_whitelist(row: dict, min_trades: int, min_wr: float, min_pf: float) -> bool:
    if row.get("error"):
        return False
    if int(row.get("trades") or 0) < min_trades:
        return False
    if float(row.get("wr") or 0) < min_wr:
        return False
    if float(row.get("pf") or 0) < min_pf:
        return False
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=90)
    ap.add_argument("--tf", default="M5")
    ap.add_argument("--symbols", default="")
    ap.add_argument("--min-conf", type=int, default=65)
    ap.add_argument("--profile", default="auto", choices=["auto", "forex", "crypto"])
    ap.add_argument("--auto-crypto", action="store_true")
    ap.add_argument("--max-symbols", type=int, default=25)
    ap.add_argument("--min-trades", type=int, default=12)
    ap.add_argument("--min-wr", type=float, default=48.0)
    ap.add_argument("--min-pf", type=float, default=1.05)
    ap.add_argument("--out", default="")
    ap.add_argument("--compact", action="store_true", default=True)
    args = ap.parse_args()

    try:
        import MetaTrader5 as mt5
    except ImportError:
        print(json.dumps({"ok": False, "error": "MetaTrader5 not installed"}), flush=True)
        return 1

    if not mt5.initialize():
        print(json.dumps({"ok": False, "error": "mt5_initialize_failed", "detail": str(mt5.last_error())}), flush=True)
        return 1

    tf_map = {"M1": mt5.TIMEFRAME_M1, "M5": mt5.TIMEFRAME_M5, "M15": mt5.TIMEFRAME_M15, "H1": mt5.TIMEFRAME_H1}
    tf = tf_map.get(args.tf.upper(), mt5.TIMEFRAME_M5)
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=max(7, min(1460, args.days)))

    if args.auto_crypto or args.profile == "crypto":
        symbols = discover_crypto_symbols(mt5, args.max_symbols)
        profile = "crypto"
        if args.min_conf == 65:
            args.min_conf = 68
    elif args.symbols.strip():
        symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
        profile = args.profile
    else:
        symbols = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "NAS100"]
        profile = args.profile

    results = []
    for sym in symbols[: args.max_symbols]:
        if not mt5.symbol_select(sym, True):
            results.append({"symbol": sym, "error": "symbol_not_found", "trades": 0})
            continue
        rates = mt5.copy_rates_range(sym, tf, start, end)
        if rates is None or len(rates) < 250:
            results.append({"symbol": sym, "error": "insufficient_data", "trades": 0, "bars": 0 if rates is None else len(rates)})
            continue
        results.append(simulate_symbol(rates, sym, args.min_conf, profile, compact=args.compact))

    mt5.shutdown()

    whitelist = [r for r in results if passes_whitelist(r, args.min_trades, args.min_wr, args.min_pf)]
    rejected = [r for r in results if r not in whitelist and not r.get("error")]
    errors = [r for r in results if r.get("error")]

    total_trades = sum(r.get("trades", 0) for r in results)
    total_wins = sum(r.get("wins", 0) for r in results)

    out = {
        "ok": True,
        "profile": profile,
        "days": args.days,
        "tf": args.tf,
        "min_conf": args.min_conf,
        "filters": {"min_trades": args.min_trades, "min_wr": args.min_wr, "min_pf": args.min_pf},
        "symbols_tested": len(symbols),
        "symbols": results,
        "whitelist": [{"symbol": r["symbol"], "trades": r["trades"], "wr": r["wr"], "pf": r["pf"], "avg_rr": r.get("avg_rr", 0)} for r in sorted(whitelist, key=lambda x: (-x.get("pf", 0), -x.get("wr", 0)))],
        "rejected_count": len(rejected),
        "error_count": len(errors),
        "summary": {
            "trades": total_trades,
            "wins": total_wins,
            "wr": round(total_wins / total_trades * 100, 1) if total_trades else 0.0,
            "whitelist_count": len(whitelist),
        },
        "generated": datetime.now(timezone.utc).isoformat(),
    }

    if args.out:
        out_path = args.out if os.path.isabs(args.out) else os.path.join(ROOT, args.out)
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        out["saved_to"] = out_path

    print(json.dumps(out, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
