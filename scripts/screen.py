#!/usr/bin/env python3
"""The wide Screen: rank the largest US equities by return/volatility over
the 200 -> 20 trading-days-ago window and rebuild membership with hysteresis
(enter at rank <= 150, stay until rank > 195).

Run every 1-4 weeks. This is the only refresh that changes membership/ranks.
New entrants get 5 years of daily adjusted closes stored; departed names'
history files are removed.
"""

import datetime as dt
import re
import sys

import fmp

# how far down the score ranking to check history depth; comfortably clears
# STAY so the eligible ranking is complete wherever membership can reach
CANDIDATE_POOL = 320

# Generous guardrails, not active constraints: on the current list, only the
# two or three thinnest names sit anywhere near these floors. They exist to
# stop a genuinely bad name from sneaking in later, not to reshape today's cut.
PRICE_FLOOR = 5.0                # a low single-digit price invites wide spreads
COARSE_DOLLAR_VOL_FLOOR = 1e6    # one day's price*volume from the initial pull -
                                  # noisy (a single day), so kept very loose;
                                  # only cuts the obviously dead before the
                                  # expensive per-name history fetch runs
PRECISE_DOLLAR_VOL_FLOOR = 3e6   # 20-day average price*volume from the
                                  # momentum-window fetch - the real gate

# A window return or a run of identical closes this extreme is more often a
# data artifact than genuine signal - logged for a manual look, never excluded
# automatically, since a few real momentum names legitimately run this hot.
EXTREME_RET_WARN = 5.0           # +500%
STALE_STREAK_WARN = 10           # consecutive identical daily closes

_SUFFIX_RE = re.compile(
    r"\b(incorporated|inc|corporation|corp|company|co|limited|ltd|llc|plc|"
    r"holdings?|group|lp)\b")
_TRAILING_CONNECTOR_RE = re.compile(r"[&,]+\s*$")


def normalize_company_name(name):
    """Collapse legal-suffix variants of the same company to one key, so e.g.
    'Victoria's Secret & Co.' and 'Victoria's Secret & Company' are recognised
    as the same business instead of quietly occupying two list slots."""
    s = name.lower().replace(".", "").replace(",", "")
    s = _SUFFIX_RE.sub("", s)
    s = _TRAILING_CONNECTOR_RE.sub("", s)
    return re.sub(r"\s+", " ", s).strip()


_DISPLAY_SUFFIX_RE = re.compile(
    r"\s+(common stock|common shares|ordinary shares)\s*$", re.I)


def clean_display_name(name):
    """Strip cosmetic security-type suffixes some feeds append to the legal
    name (e.g. 'BrightSpring Health Services, Inc. Common Stock') - display
    only, independent of the dedup key above."""
    return _DISPLAY_SUFFIX_RE.sub("", name).strip()


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
            "spac", "warrant", "unit ", " units",
            "blank check", "special purpose acquisition")
    seen_company = {}
    too_cheap = too_illiquid = 0
    for r in rows:
        name = clean_display_name((r.get("companyName") or "").strip())
        sym = r.get("symbol") or ""
        cap = r.get("marketCap") or 0
        if not name or not sym or not cap:
            continue
        low = name.lower()
        if any(k in low for k in junk):
            continue
        if "." in sym or "+" in sym or "=" in sym or len(sym) > 6:
            continue
        price = r.get("price") or 0
        if price < PRICE_FLOOR:
            too_cheap += 1
            continue
        # coarse and noisy (one day's volume), so deliberately loose - just
        # cuts the obviously dead before the expensive per-name fetches below
        if price * (r.get("volume") or 0) < COARSE_DOLLAR_VOL_FLOOR:
            too_illiquid += 1
            continue
        r["companyName"] = name
        # one share class per company: keep the largest market cap. Matched on
        # a normalized name (legal suffix and punctuation stripped) so e.g.
        # "Victoria's Secret & Co." and "... & Company" collapse to one entry.
        key = normalize_company_name(name)
        if key not in seen_company or cap > seen_company[key]["marketCap"]:
            seen_company[key] = r
    uni = sorted(seen_company.values(), key=lambda r: -r["marketCap"])[:fmp.UNIVERSE_SIZE]
    print(f"universe: {len(rows)} screened -> {len(uni)} after filters "
          f"({too_cheap} under ${PRICE_FLOOR:.0f}, {too_illiquid} under "
          f"${COARSE_DOLLAR_VOL_FLOOR/1e6:.0f}M coarse volume)", file=sys.stderr)
    return uni


def main(reset=False):
    today = dt.date.today()
    window_start = (today - dt.timedelta(days=320)).isoformat()
    five_years_ago = (today - dt.timedelta(days=int(fmp.HISTORY_YEARS * 365.25))).isoformat()

    uni = build_universe()
    info = {r["symbol"]: r for r in uni}

    # score the whole universe on ~320 calendar days of adjusted closes
    hist = fmp.fetch_many(list(info),
                          lambda s: fmp.adjusted_history_with_volume(s, window_start),
                          label="window history")
    scored, too_illiquid_precise = [], 0
    for sym, (dates, closes, volumes) in hist.items():
        mom = fmp.momentum(closes)
        if mom is None:
            continue
        score, ret, vol = mom

        # precise liquidity gate: a real 20-day average, not one noisy day
        recent = min(20, len(closes))
        dollar_vols = [closes[i] * volumes[i] for i in range(len(closes) - recent, len(closes))]
        avg_dollar_vol = sum(dollar_vols) / len(dollar_vols) if dollar_vols else 0
        if avg_dollar_vol < PRECISE_DOLLAR_VOL_FLOOR:
            too_illiquid_precise += 1
            continue

        if abs(ret) > EXTREME_RET_WARN:
            print(f"  note: {sym} window return {ret*100:.0f}% is extreme - "
                  f"worth a manual look, not auto-excluded", file=sys.stderr)
        streak = longest = 1
        for i in range(1, len(closes)):
            streak = streak + 1 if closes[i] == closes[i - 1] else 1
            longest = max(longest, streak)
        if longest >= STALE_STREAK_WARN:
            print(f"  note: {sym} has {longest} identical consecutive closes - "
                  f"check for a stale feed", file=sys.stderr)

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
    print(f"scored {len(scored)} names ({too_illiquid_precise} excluded under "
          f"${PRECISE_DOLLAR_VOL_FLOOR/1e6:.0f}M 20-day avg volume)", file=sys.stderr)

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

    # hysteresis against previous membership (ignore sample data). --reset
    # starts clean, so the run lands exactly on KEEP instead of grandfathering
    # yesterday's members through the KEEP..STAY band - what you want after
    # changing KEEP, since otherwise the old band silently inflates the count.
    prev_meta = fmp.load_json(fmp.DATA / "meta.json", {}) or {}
    prev = fmp.load_json(fmp.DATA / "screen.json", {}) or {}
    prev_members = set()
    if reset:
        print("  --reset: ignoring previous membership, no hysteresis this run",
              file=sys.stderr)
    elif not prev_meta.get("fake"):
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
        "priceFloor": PRICE_FLOOR,
        "minAvgDollarVolume": PRECISE_DOLLAR_VOL_FLOOR,
        "keep": fmp.KEEP,
        "stay": fmp.STAY,
        "fake": False,
    }, compact=False)
    print(f"done: {len(members)} members, prices through {max(last_dates)}")


if __name__ == "__main__":
    if not fmp.API_KEY:
        sys.exit("FMP_API_KEY (or API_KEY) is not set")
    main(reset="--reset" in sys.argv)
