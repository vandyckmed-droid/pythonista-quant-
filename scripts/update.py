#!/usr/bin/env python3
"""The daily Update: members only. Catches up all price data since the last
run (skipped days never leave gaps), refreshes price/change/sparkline fields,
and leaves membership, ranks and scores untouched.

If a stored series no longer matches the vendor's adjusted series at the
overlap point (split or dividend re-adjustment), the full 5 years are
refetched for that symbol.
"""

import datetime as dt
import sys

import fmp


def catch_up(symbol):
    stored = fmp.load_history(symbol)
    five_years_ago = (dt.date.today()
                      - dt.timedelta(days=int(fmp.HISTORY_YEARS * 365.25))).isoformat()
    if not stored or not stored["dates"]:
        return fmp.adjusted_history(symbol, five_years_ago)

    last = stored["dates"][-1]
    dates, closes = fmp.adjusted_history(symbol, last)  # inclusive overlap
    if not dates:
        return stored["dates"], stored["close"]

    # overlap check: stored last close must still match the adjusted series
    if dates[0] == last:
        drift = abs(closes[0] / stored["close"][-1] - 1)
        if drift > 0.001:
            print(f"  {symbol}: adjusted series shifted ({drift:.2%}), refetching 5y",
                  file=sys.stderr)
            return fmp.adjusted_history(symbol, five_years_ago)
        dates, closes = dates[1:], closes[1:]

    return stored["dates"] + dates, stored["close"] + closes


def main():
    screen = fmp.load_json(fmp.DATA / "screen.json")
    meta = fmp.load_json(fmp.DATA / "meta.json", {}) or {}
    if not screen or meta.get("fake"):
        sys.exit("no real screen.json yet — run screen.py first")

    members = screen["members"]
    results = fmp.fetch_many([m["symbol"] for m in members], catch_up, label="update")

    last_dates = []
    for m in members:
        if m["symbol"] not in results:
            continue  # fetch failed; stored data stays as-is
        dates, closes = results[m["symbol"]]
        fmp.save_history(m["symbol"], dates, closes)
        fmp.member_summary(m, dates, closes)
        last_dates.append(dates[-1])

    fmp.save_json(fmp.DATA / "screen.json", {"members": members})
    meta["lastUpdate"] = fmp.now_iso()
    meta["pricesThrough"] = max(last_dates) if last_dates else meta.get("pricesThrough")
    fmp.save_json(fmp.DATA / "meta.json", meta, compact=False)
    print(f"done: {len(results)}/{len(members)} members updated, "
          f"prices through {meta['pricesThrough']}")


if __name__ == "__main__":
    if not fmp.API_KEY:
        sys.exit("FMP_API_KEY (or API_KEY) is not set")
    main()
