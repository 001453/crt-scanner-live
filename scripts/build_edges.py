#!/usr/bin/env python3
"""
MT5'ten tum broker sembolleri icin edge istatistikleri uretir -> data/edges.json
Gereksinim: CRT_PYTHON + MetaTrader5 (crt_ai_proxy_server ile ayni ortam)

Ornek:
  set CRT_PYTHON=D:\\Projects\\forex\\runtime\\python313\\python.exe
  python scripts/build_edges.py --years 5 --out data/edges.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)


def main() -> int:
    p = argparse.ArgumentParser(description="Build probability edge DB from MT5 history")
    p.add_argument("--out", default=os.path.join(ROOT, "data", "edges.json"))
    p.add_argument("--years", type=int, default=5)
    p.add_argument("--dry-run", action="store_true", help="Only list symbols, do not write")
    args = p.parse_args()

    try:
        import MetaTrader5 as mt5  # noqa: F401
    except ImportError:
        print("MetaTrader5 yok. CRT_PYTHON ile calistirin.", file=sys.stderr)
        return 1

    if not mt5.initialize():
        print(f"MT5 init failed: {mt5.last_error()}", file=sys.stderr)
        return 1

    symbols = mt5.symbols_get()
    names = sorted({s.name for s in (symbols or []) if s and getattr(s, "visible", True)})
    print(f"symbols={len(names)} dry_run={args.dry_run}")

    if args.dry_run:
        mt5.shutdown()
        return 0

    # TODO: H1 mumlardan TR seans/saat/ay bull% hesapla; simdilik mevcut edges.json korunur
    out_path = args.out
    existing = {}
    if os.path.isfile(out_path):
        with open(out_path, encoding="utf-8") as f:
            existing = json.load(f)

    payload = {
        "version": int(existing.get("version", 1)) + 1,
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "description": f"MT5 build stub — {len(names)} symbols listed; stats pipeline TODO",
        "categoryProfiles": existing.get("categoryProfiles") or {"default": "EURUSD"},
        "pairAliases": existing.get("pairAliases") or {},
        "pairs": existing.get("pairs") or {},
        "build_meta": {"symbol_count": len(names), "years": args.years},
    }
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"wrote {out_path} direct_pairs={len(payload['pairs'])}")
    mt5.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
