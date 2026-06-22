"""One-off: print broker TP/SL USD estimates for open positions and pending orders."""
import json
import os
import sys

import MetaTrader5 as mt5

path = os.environ.get("MT5_PATH", "")
login = int(os.environ.get("MT5_LOGIN", "0") or 0)
password = os.environ.get("MT5_PASSWORD", "")
server = os.environ.get("MT5_SERVER", "")
if path:
    ok = mt5.initialize(path=path, login=login, password=password, server=server)
else:
    ok = mt5.initialize(login=login, password=password, server=server)
if not ok:
    print(json.dumps({"ok": False, "error": str(mt5.last_error())}))
    sys.exit(1)


def est(symbol, side, vol, entry, px):
    ot = mt5.ORDER_TYPE_BUY if side == "LONG" else mt5.ORDER_TYPE_SELL
    si = mt5.symbol_info(symbol)
    d = int(getattr(si, "digits", 5) or 5)
    pr = float(mt5.order_calc_profit(ot, symbol, vol, round(entry, d), round(px, d)) or 0)
    return pr, (-pr if pr < 0 else 0)


out = []
for p in mt5.positions_get() or []:
    side = "LONG" if p.type == 0 else "SHORT"
    tp_p, _ = est(p.symbol, side, p.volume, p.price_open, p.tp) if p.tp else (0, 0)
    _, sl_l = est(p.symbol, side, p.volume, p.price_open, p.sl) if p.sl else (0, 0)
    out.append(
        {
            "kind": "open",
            "ticket": p.ticket,
            "symbol": p.symbol,
            "side": side,
            "lot": p.volume,
            "entry": p.price_open,
            "sl": p.sl,
            "tp": p.tp,
            "pnl": p.profit,
            "tp_usd": round(tp_p, 2),
            "sl_loss_usd": round(sl_l, 2),
        }
    )
for o in mt5.orders_get() or []:
    side = "LONG" if o.type in (2, 4) else "SHORT"
    tp_p, _ = est(o.symbol, side, o.volume_current, o.price_open, o.tp) if o.tp else (0, 0)
    _, sl_l = est(o.symbol, side, o.volume_current, o.price_open, o.sl) if o.sl else (0, 0)
    out.append(
        {
            "kind": "pending",
            "ticket": o.ticket,
            "symbol": o.symbol,
            "side": side,
            "lot": o.volume_current,
            "entry": o.price_open,
            "sl": o.sl,
            "tp": o.tp,
            "tp_usd": round(tp_p, 2),
            "sl_loss_usd": round(sl_l, 2),
        }
    )
mt5.shutdown()
print(json.dumps({"ok": True, "items": out}, indent=2))
