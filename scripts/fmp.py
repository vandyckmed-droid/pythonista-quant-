"""Shared helpers for the FMP data pipeline. Stdlib only."""

import json
import os
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
HIST = DATA / "history"

BASE = "https://financialmodelingprep.com/stable"
API_KEY = os.environ.get("FMP_API_KEY") or os.environ.get("API_KEY") or ""

WINDOW_FAR = 200   # trading days ago
WINDOW_NEAR = 20
KEEP = 150         # enter at rank <= KEEP
STAY = 195         # members stay until rank > STAY
UNIVERSE_SIZE = 1500
HISTORY_YEARS = 5

import threading

_throttle = threading.Lock()
_last_call = [0.0]
_MIN_INTERVAL = 0.09   # ~11 req/s, well under premium limits


def get(endpoint, **params):
    """GET a stable-API endpoint, parsed JSON, with retry and throttling."""
    params["apikey"] = API_KEY
    url = f"{BASE}/{endpoint}?{urllib.parse.urlencode(params)}"
    for attempt in range(4):
        with _throttle:
            wait = _MIN_INTERVAL - (time.time() - _last_call[0])
            if wait > 0:
                time.sleep(wait)
            _last_call[0] = time.time()
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                body = json.loads(r.read())
            if isinstance(body, dict) and "Error Message" in body:
                raise RuntimeError(body["Error Message"])
            return body
        except Exception as e:
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)


def fetch_many(symbols, fn, workers=6, label="fetch"):
    """Run fn(symbol) concurrently; returns {symbol: result}, skipping failures."""
    out, failed = {}, []

    def one(sym):
        try:
            return sym, fn(sym)
        except Exception as e:
            return sym, e

    with ThreadPoolExecutor(max_workers=workers) as ex:
        for i, (sym, res) in enumerate(ex.map(one, symbols)):
            if isinstance(res, Exception):
                failed.append(sym)
            else:
                out[sym] = res
            if (i + 1) % 100 == 0:
                print(f"  {label}: {i + 1}/{len(symbols)}", file=sys.stderr)

    # second chance, sequentially — most first-pass failures are transient
    still = []
    for sym in failed:
        time.sleep(1)
        try:
            out[sym] = fn(sym)
        except Exception:
            still.append(sym)
    if still:
        print(f"  {label}: {len(still)} failed after retry: {', '.join(still[:10])}"
              + ("…" if len(still) > 10 else ""), file=sys.stderr)
    return out


def adjusted_history(symbol, from_date=None):
    """Daily dividend-adjusted closes, oldest first: (dates, closes)."""
    params = {"symbol": symbol}
    if from_date:
        params["from"] = from_date
    rows = get("historical-price-eod/dividend-adjusted", **params)
    rows = sorted(rows, key=lambda r: r["date"])
    return [r["date"] for r in rows], [round(float(r["adjClose"]), 4) for r in rows]


def load_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def save_json(path, obj, compact=True):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        if compact:
            json.dump(obj, f, separators=(",", ":"))
        else:
            json.dump(obj, f, indent=2)


def save_history(symbol, dates, closes):
    save_json(HIST / f"{symbol}.json",
              {"symbol": symbol, "dates": dates, "close": closes})


def load_history(symbol):
    return load_json(HIST / f"{symbol}.json")


def momentum(closes):
    """(score, ret, vol) over the WINDOW_FAR -> WINDOW_NEAR window."""
    import math
    w = closes[-WINDOW_FAR:-WINDOW_NEAR]
    if len(w) < (WINDOW_FAR - WINDOW_NEAR) * 0.8 or w[0] <= 0:
        return None
    ret = w[-1] / w[0] - 1
    rets = [math.log(w[i] / w[i - 1]) for i in range(1, len(w)) if w[i - 1] > 0]
    mu = sum(rets) / len(rets)
    var = sum((x - mu) ** 2 for x in rets) / (len(rets) - 1)
    vol = (var * 252) ** 0.5
    if vol <= 0:
        return None
    return ret / vol, ret, vol


def member_summary(m, dates, closes):
    """Fields the UI reads that refresh on every update."""
    m["price"] = round(closes[-1], 2)
    m["chg1d"] = round(closes[-1] / closes[-2] - 1, 4) if len(closes) > 1 else 0.0
    m["spark"] = [round(c, 2) for c in closes[-30:]]
    return m


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
