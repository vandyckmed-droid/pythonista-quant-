#!/usr/bin/env python3
"""The wide Screen: rank ~1500 largest US equities by return/volatility over
the 200 -> 20 trading-days-ago window and rebuild membership with hysteresis
(enter at rank <= 150, stay until rank > 195).

Run every 1-4 weeks. This is the only refresh that changes membership/ranks.
New entrants get 5 years of daily adjusted closes stored; departed names'
history files are removed.
"""

import datetime as dt
import sys

import fmp

# how far down the score ranking to check history depth; comfortably clears
# STAY so the eligible ranking is complete wherever membership can reach
CANDIDATE_POOL = 320


def build_universe():
    rows = fmp.get(
        "company-screener", _timeout=180,
        marketCapMoreThan=1_000_000_000,
        country="US",
        exchange="NYSE,NASDAQ,AMEX",
        isEtf="false", isFund="false", isActivelyTrading="true",
        limit=5000,
    )
    junk = ("fund", "trust", "etf", " reit index", "acquisition corp", "holdings iv",
            "spac", "warrant", "unit ", " units")
    seen_company = {}
    for r in rows:
        name = (r.get("companyName") or "").strip()
        sym = r.get("symbol") or ""
        cap = r.get("marketCap") or 0
        if not name or not sym or not cap:
            continue
        low = name.lower()
        if any(k in low for k in junk):
            continue
        if "." in sym or "+" in sym or "=" in sym or len(sym) > 6:
            continue
        # one share class per company: keep the largest market cap
        key = low
        if key not in seen_company or cap > seen_company[key]["marketCap"]:
            seen_company[key] = r
    uni = sorted(seen_company.values(), key=lambda r: -r["marketCap"])[:fmp.UNIVERSE_SIZE]
    print(f"universe: {len(rows)} screened -> {len(uni)} after filters", file=sys.stderr)
    return uni


def main():
    today = dt.date.today()
    window_start = (today - dt.timedelta(days=320)).isoformat()
    five_years_ago = (today - dt.timedelta(days=int(fmp.HISTORY_YEARS * 365.25))).isoformat()

    uni = build_universe()
    info = {r["symbol"]: r for r in uni}

    # score the whole universe on ~320 calendar days of adjusted closes
    hist = fmp.fetch_many(list(info), lambda s: fmp.adjusted_history(s, window_start),
                          label="window history")
    scored = []
    for sym, (dates, closes) in hist.items():
        mom = fmp.momentum(closes)
        if mom is None:
            continue
        score, ret, vol = mom
        scored.append({
            "symbol": sym,
            "name": info[sym]["companyName"],
            "sector": info[sym].get("sector") or "—",
            "industry": info[sym].get("industry") or "—",
            "score": round(score, 4),
            "ret": round(ret, 4),
            "vol": round(vol, 4),
        })
    scored.sort(key=lambda m: -m["score"])
    print(f"scored {len(scored)} names", file=sys.stderr)

    # Deep history only for names that could plausibly make the list — that's
    # also where the MIN_HISTORY_DAYS test happens, so a name too new to be
    # risk-analysed never enters the ranking at all.
    pool = scored[:CANDIDATE_POOL]
    fullh = fmp.fetch_many([m["symbol"] for m in pool],
                           lambda s: fmp.adjusted_history(s, five_years_ago),
                           label="5y history")
    eligible, too_new = [], 0
    for m in pool:
        got = fullh.get(m["symbol"])
        if not got:
            continue
        if len(got[1]) < fmp.MIN_HISTORY_DAYS:
            too_new += 1
            continue
        eligible.append(m)
    print(f"eligible: {len(eligible)} of {len(pool)} candidates "
          f"({too_new} too new for {fmp.MIN_HISTORY_DAYS} trading days)", file=sys.stderr)

    for i, m in enumerate(eligible):
        m["rank"] = i + 1

    # hysteresis against previous membership (ignore sample data)
    prev_meta = fmp.load_json(fmp.DATA / "meta.json", {}) or {}
    prev = fmp.load_json(fmp.DATA / "screen.json", {}) or {}
    prev_members = set()
    if not prev_meta.get("fake"):
        prev_members = {m["symbol"] for m in prev.get("members", [])}

    members = [m for m in eligible
               if m["rank"] <= fmp.KEEP
               or (m["symbol"] in prev_members and m["rank"] <= fmp.STAY)]
    print(f"membership: {len(members)} "
          f"({len([m for m in members if m['symbol'] not in prev_members])} new)",
          file=sys.stderr)
    last_dates = []
    for m in members:
        dates, closes = fullh[m["symbol"]]
        fmp.save_history(m["symbol"], dates, closes)
        fmp.member_summary(m, dates, closes)
        last_dates.append(dates[-1])

    # drop history files of names that left the list
    keep = {m["symbol"] for m in members}
    for f in fmp.HIST.glob("*.json"):
        if f.stem not in keep:
            f.unlink()

    fmp.save_json(fmp.DATA / "screen.json", {"members": members})
    fmp.fetch_benchmark(five_years_ago)
    fmp.build_risk_file(members)
    fmp.archive_screen(members)
    fmp.save_json(fmp.DATA / "meta.json", {
        "lastScreen": fmp.now_iso(),
        "lastUpdate": fmp.now_iso(),
        "pricesThrough": max(last_dates) if last_dates else None,
        "window": {"far": fmp.WINDOW_FAR, "near": fmp.WINDOW_NEAR},
        "universeScanned": len(uni),
        "members": len(members),
        "minHistoryDays": fmp.MIN_HISTORY_DAYS,
        "fake": False,
    }, compact=False)
    print(f"done: {len(members)} members, prices through {max(last_dates)}")


if __name__ == "__main__":
    if not fmp.API_KEY:
        sys.exit("FMP_API_KEY (or API_KEY) is not set")
    main()
