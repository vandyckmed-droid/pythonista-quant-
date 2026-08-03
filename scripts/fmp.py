"""Shared helpers for the FMP data pipeline. Stdlib only."""

import json
import math
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
MIN_HISTORY_DAYS = 504   # ~2 years; a name with less can't be risk-analyzed,
                         # so it never enters the universe at all
N_CLUSTERS = 8           # behaviour families shown in the app
BENCHMARK = "VTI"        # total US market — matches a universe that runs down
                         # to $1B, unlike large-cap-only SPY

import threading

_throttle = threading.Lock()
_last_call = [0.0]
_MIN_INTERVAL = 0.09   # ~11 req/s, well under premium limits


def get(endpoint, _timeout=60, **params):
    """GET a stable-API endpoint, parsed JSON, with retry and throttling."""
    params["apikey"] = API_KEY
    url = f"{BASE}/{endpoint}?{urllib.parse.urlencode(params)}"
    for attempt in range(5):
        with _throttle:
            wait = _MIN_INTERVAL - (time.time() - _last_call[0])
            if wait > 0:
                time.sleep(wait)
            _last_call[0] = time.time()
        try:
            with urllib.request.urlopen(url, timeout=_timeout) as r:
                body = json.loads(r.read())
            if isinstance(body, dict) and "Error Message" in body:
                raise RuntimeError(body["Error Message"])
            return body
        except Exception as e:
            if attempt == 4:
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


def adjusted_history_with_volume(symbol, from_date=None):
    """Like adjusted_history, but also returns each day's volume - the same
    endpoint already carries it; nothing extra to fetch."""
    params = {"symbol": symbol}
    if from_date:
        params["from"] = from_date
    rows = get("historical-price-eod/dividend-adjusted", **params)
    rows = sorted(rows, key=lambda r: r["date"])
    dates = [r["date"] for r in rows]
    closes = [round(float(r["adjClose"]), 4) for r in rows]
    volumes = [r.get("volume") or 0 for r in rows]
    return dates, closes, volumes


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


# ---------------------------------------------------------------------------
# Correlations and behaviour families, precomputed here so the phone doesn't
# have to load 150 history files to answer "does this name add anything?"
# ---------------------------------------------------------------------------

def _aligned_returns(members):
    """Daily log returns for every member over their shared dates."""
    hist = {}
    for m in members:
        h = load_history(m["symbol"])
        if h and len(h["dates"]) > 1:
            hist[m["symbol"]] = h
    syms = [m["symbol"] for m in members if m["symbol"] in hist]
    common = set(hist[syms[0]]["dates"])
    for s in syms[1:]:
        common &= set(hist[s]["dates"])
    common = sorted(common)

    rets = {}
    for s in syms:
        pos = {d: i for i, d in enumerate(hist[s]["dates"])}
        c = [hist[s]["close"][pos[d]] for d in common]
        rets[s] = [math.log(c[i] / c[i - 1]) for i in range(1, len(c))
                   if c[i] > 0 and c[i - 1] > 0]
    return syms, rets, common


def _correlation(syms, rets):
    n, T = len(syms), len(rets[syms[0]])
    mu = {s: sum(rets[s]) / T for s in syms}
    sd = {s: math.sqrt(sum((x - mu[s]) ** 2 for x in rets[s]) / (T - 1)) or 1e-12
          for s in syms}
    C = [[1.0] * n for _ in range(n)]
    for i in range(n):
        ri, mi, si = rets[syms[i]], mu[syms[i]], sd[syms[i]]
        for j in range(i + 1, n):
            rj, mj, sj = rets[syms[j]], mu[syms[j]], sd[syms[j]]
            cov = sum((ri[t] - mi) * (rj[t] - mj) for t in range(T)) / (T - 1)
            C[i][j] = C[j][i] = max(-1.0, min(1.0, cov / (si * sj)))
    return C


def fetch_benchmark(from_date):
    """Store the benchmark's own price history alongside the members."""
    dates, closes = adjusted_history(BENCHMARK, from_date)
    save_json(DATA / "benchmark.json",
              {"symbol": BENCHMARK, "dates": dates, "close": closes})
    return dates, closes


def _benchmark_returns(common):
    """Benchmark log returns aligned to the members' shared dates, or None."""
    b = load_json(DATA / "benchmark.json")
    if not b:
        return None
    pos = {d: i for i, d in enumerate(b["dates"])}
    if not all(d in pos for d in common):
        print(f"  benchmark {BENCHMARK} missing some member dates — "
              f"falling back to the internal proxy", file=sys.stderr)
        return None
    c = [b["close"][pos[d]] for d in common]
    return [math.log(c[i] / c[i - 1]) for i in range(1, len(c))]


def _residuals(syms, rets, market):
    """Strip the common market move, leaving each name's own behaviour.

    Almost everything is positively correlated with the market, which makes raw
    correlations cluster into one giant blob. What distinguishes names — and
    what a "family" should capture — is what's left once the shared move is out.

    Returns (residuals, betas). `market` should be the benchmark's returns; the
    equal-weight average of the members is a poor stand-in, because a screen
    tilted toward one sector makes that average partly a sector factor, and
    subtracting it erases the very structure families are meant to show.
    """
    T = len(rets[syms[0]])
    mm = sum(market) / T
    vm = sum((x - mm) ** 2 for x in market) / (T - 1) or 1e-12
    res, betas = {}, {}
    for s in syms:
        ms = sum(rets[s]) / T
        beta = sum((rets[s][t] - ms) * (market[t] - mm) for t in range(T)) / (T - 1) / vm
        betas[s] = beta
        res[s] = [rets[s][t] - beta * market[t] for t in range(T)]
    return res, betas


def _cluster(C, k):
    """Complete-linkage agglomerative clustering on correlation distance.

    Complete linkage (rather than the single linkage HRP uses internally) keeps
    the displayed families balanced instead of one blob plus singletons.
    """
    n = len(C)
    d = [[math.sqrt(max(0.0, 0.5 * (1 - C[i][j]))) for j in range(n)] for i in range(n)]
    groups = {i: [i] for i in range(n)}
    active = set(range(n))
    while len(active) > k:
        bi = bj = None
        bd = float("inf")
        for i in active:
            for j in active:
                if j <= i:
                    continue
                if d[i][j] < bd:
                    bd, bi, bj = d[i][j], i, j
        for m in active:
            if m in (bi, bj):
                continue
            d[bi][m] = d[m][bi] = max(d[bi][m], d[bj][m])
        groups[bi] += groups[bj]
        del groups[bj]
        active.discard(bj)

    out = [0] * n
    # biggest family first, so colour slot 1 is the most common behaviour
    for cid, members in enumerate(sorted(groups.values(), key=len, reverse=True)):
        for i in members:
            out[i] = cid
    return out


def _label_clusters(groups):
    """Name each family by the sectors its members share, keeping names unique.

    `groups` is a list of (symbols, sectors) in display order.
    """
    labels = []
    for _, tags in groups:
        # tags is (industry, sector) per member — a shared industry is a much
        # sharper name than a shared sector ("Semiconductors" beats "Technology")
        for level in (0, 1):
            counts = {}
            for t in tags:
                counts[t[level]] = counts.get(t[level], 0) + 1
            ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
            top, hits = ordered[0]
            if hits / len(tags) >= 0.4 and top != "—":
                labels.append(top)
                break
        else:
            labels.append(" & ".join(k for k, _ in ordered[:2]))

    # two families can legitimately share a dominant sector (e.g. two distinct
    # kinds of healthcare) — disambiguate with the family's largest name
    seen = {}
    for i, lab in enumerate(labels):
        seen.setdefault(lab, []).append(i)
    for lab, idxs in seen.items():
        if len(idxs) > 1:
            for i in idxs:
                labels[i] = f"{lab} ({groups[i][0][0]})"
    return labels


def build_risk_file(members):
    """Write data/risk.json: correlation matrix + behaviour families."""
    syms, rets, common = _aligned_returns(members)
    if len(syms) < 3 or len(rets[syms[0]]) < 60:
        print("  not enough shared history for risk.json", file=sys.stderr)
        return
    C = _correlation(syms, rets)
    # families come from residual behaviour; the matrix the app shows stays raw
    market = _benchmark_returns(common)
    used_benchmark = market is not None
    if market is None:   # last resort: the members' own average
        T = len(rets[syms[0]])
        market = [sum(rets[s][t] for s in syms) / len(syms) for t in range(T)]
    res, betas = _residuals(syms, rets, market)
    labels = _cluster(_correlation(syms, res), min(N_CLUSTERS, len(syms)))

    tag = {m["symbol"]: (m.get("industry") or "—", m.get("sector") or "—")
           for m in members}
    rank = {m["symbol"]: m["rank"] for m in members}
    groups = []
    for cid in range(max(labels) + 1):
        mem = sorted((syms[i] for i in range(len(syms)) if labels[i] == cid),
                     key=lambda s: rank.get(s, 9999))
        groups.append((mem, [tag[s] for s in mem]))
    names = _label_clusters(groups)

    save_json(DATA / "risk.json", {
        "symbols": syms,
        "corr": [[round(v, 2) for v in row] for row in C],
        "cluster": {syms[i]: labels[i] for i in range(len(syms))},
        "clusterNames": names,
        "beta": {s: round(betas[s], 2) for s in syms},
        "benchmark": BENCHMARK if used_benchmark else None,
        "days": len(rets[syms[0]]),
        "from": common[0],
        "to": common[-1],
    })
    sizes = [sum(1 for x in labels if x == c) for c in range(len(names))]
    print(f"  risk.json: {len(syms)} names, {len(rets[syms[0]])} shared days, "
          f"market factor {BENCHMARK if used_benchmark else 'internal proxy'}, "
          f"families {list(zip(names, sizes))}", file=sys.stderr)


def archive_screen(members):
    """Keep a point-in-time copy of each screen so ranks can be back-tested."""
    day = time.strftime("%Y-%m-%d", time.gmtime())
    save_json(DATA / "archive" / f"screen-{day}.json", {
        "date": day,
        "members": [{"symbol": m["symbol"], "rank": m["rank"], "score": m["score"]}
                    for m in members],
    })
