#!/usr/bin/env python3
"""Generate fake data shaped exactly like the real pipeline output.

Writes:
  data/meta.json            - timestamps + screen parameters
  data/screen.json          - ranked member list with summary stats + sparklines
  data/history/{SYM}.json   - ~5y of daily adjusted closes per member

Deterministic (seeded) so regeneration is stable. Stdlib only.
"""

import json
import math
import random
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
HIST = DATA / "history"

END_DATE = date(2026, 7, 31)  # last completed trading day for the fake set
YEARS = 5
WINDOW_FAR = 200  # trading days ago
WINDOW_NEAR = 20

# (symbol, name, sector) — well-known US large caps, enough for a 150-member list
UNIVERSE = [
    ("AAPL", "Apple", "Technology"), ("MSFT", "Microsoft", "Technology"),
    ("NVDA", "NVIDIA", "Technology"), ("AMZN", "Amazon", "Consumer Cyclical"),
    ("GOOGL", "Alphabet", "Communication Services"), ("META", "Meta Platforms", "Communication Services"),
    ("AVGO", "Broadcom", "Technology"), ("TSLA", "Tesla", "Consumer Cyclical"),
    ("BRK-B", "Berkshire Hathaway", "Financial Services"), ("JPM", "JPMorgan Chase", "Financial Services"),
    ("LLY", "Eli Lilly", "Healthcare"), ("V", "Visa", "Financial Services"),
    ("XOM", "Exxon Mobil", "Energy"), ("UNH", "UnitedHealth", "Healthcare"),
    ("MA", "Mastercard", "Financial Services"), ("PG", "Procter & Gamble", "Consumer Defensive"),
    ("COST", "Costco", "Consumer Defensive"), ("JNJ", "Johnson & Johnson", "Healthcare"),
    ("HD", "Home Depot", "Consumer Cyclical"), ("ABBV", "AbbVie", "Healthcare"),
    ("WMT", "Walmart", "Consumer Defensive"), ("NFLX", "Netflix", "Communication Services"),
    ("BAC", "Bank of America", "Financial Services"), ("CRM", "Salesforce", "Technology"),
    ("ORCL", "Oracle", "Technology"), ("CVX", "Chevron", "Energy"),
    ("KO", "Coca-Cola", "Consumer Defensive"), ("AMD", "AMD", "Technology"),
    ("PEP", "PepsiCo", "Consumer Defensive"), ("TMO", "Thermo Fisher", "Healthcare"),
    ("LIN", "Linde", "Basic Materials"), ("ADBE", "Adobe", "Technology"),
    ("MCD", "McDonald's", "Consumer Cyclical"), ("CSCO", "Cisco", "Technology"),
    ("ACN", "Accenture", "Technology"), ("ABT", "Abbott Labs", "Healthcare"),
    ("PM", "Philip Morris", "Consumer Defensive"), ("GE", "GE Aerospace", "Industrials"),
    ("IBM", "IBM", "Technology"), ("TXN", "Texas Instruments", "Technology"),
    ("QCOM", "Qualcomm", "Technology"), ("INTU", "Intuit", "Technology"),
    ("DIS", "Disney", "Communication Services"), ("WFC", "Wells Fargo", "Financial Services"),
    ("VZ", "Verizon", "Communication Services"), ("CAT", "Caterpillar", "Industrials"),
    ("AMGN", "Amgen", "Healthcare"), ("NOW", "ServiceNow", "Technology"),
    ("ISRG", "Intuitive Surgical", "Healthcare"), ("GS", "Goldman Sachs", "Financial Services"),
    ("NEE", "NextEra Energy", "Utilities"), ("RTX", "RTX", "Industrials"),
    ("SPGI", "S&P Global", "Financial Services"), ("UBER", "Uber", "Technology"),
    ("PFE", "Pfizer", "Healthcare"), ("CMCSA", "Comcast", "Communication Services"),
    ("T", "AT&T", "Communication Services"), ("LOW", "Lowe's", "Consumer Cyclical"),
    ("BLK", "BlackRock", "Financial Services"), ("UNP", "Union Pacific", "Industrials"),
    ("HON", "Honeywell", "Industrials"), ("SYK", "Stryker", "Healthcare"),
    ("BKNG", "Booking Holdings", "Consumer Cyclical"), ("ETN", "Eaton", "Industrials"),
    ("AXP", "American Express", "Financial Services"), ("PGR", "Progressive", "Financial Services"),
    ("LMT", "Lockheed Martin", "Industrials"), ("TJX", "TJX", "Consumer Cyclical"),
    ("COP", "ConocoPhillips", "Energy"), ("BSX", "Boston Scientific", "Healthcare"),
    ("MDT", "Medtronic", "Healthcare"), ("PANW", "Palo Alto Networks", "Technology"),
    ("VRTX", "Vertex Pharma", "Healthcare"), ("ADP", "ADP", "Technology"),
    ("MU", "Micron", "Technology"), ("GILD", "Gilead Sciences", "Healthcare"),
    ("SBUX", "Starbucks", "Consumer Cyclical"), ("PLTR", "Palantir", "Technology"),
    ("ANET", "Arista Networks", "Technology"), ("LRCX", "Lam Research", "Technology"),
    ("KLAC", "KLA", "Technology"), ("AMAT", "Applied Materials", "Technology"),
    ("INTC", "Intel", "Technology"), ("SCHW", "Charles Schwab", "Financial Services"),
    ("MMC", "Marsh & McLennan", "Financial Services"), ("DE", "Deere", "Industrials"),
    ("CB", "Chubb", "Financial Services"), ("BMY", "Bristol Myers", "Healthcare"),
    ("PLD", "Prologis", "Real Estate"), ("SO", "Southern Company", "Utilities"),
    ("BA", "Boeing", "Industrials"), ("ELV", "Elevance Health", "Healthcare"),
    ("MO", "Altria", "Consumer Defensive"), ("DUK", "Duke Energy", "Utilities"),
    ("SHW", "Sherwin-Williams", "Basic Materials"), ("NKE", "Nike", "Consumer Cyclical"),
    ("MDLZ", "Mondelez", "Consumer Defensive"), ("ICE", "Intercontinental Exchange", "Financial Services"),
    ("CI", "Cigna", "Healthcare"), ("WM", "Waste Management", "Industrials"),
    ("GEV", "GE Vernova", "Utilities"), ("CL", "Colgate-Palmolive", "Consumer Defensive"),
    ("MCO", "Moody's", "Financial Services"), ("APH", "Amphenol", "Technology"),
    ("CTAS", "Cintas", "Industrials"), ("ZTS", "Zoetis", "Healthcare"),
    ("CME", "CME Group", "Financial Services"), ("EQIX", "Equinix", "Real Estate"),
    ("CDNS", "Cadence Design", "Technology"), ("SNPS", "Synopsys", "Technology"),
    ("CRWD", "CrowdStrike", "Technology"), ("MSI", "Motorola Solutions", "Technology"),
    ("ITW", "Illinois Tool Works", "Industrials"), ("TDG", "TransDigm", "Industrials"),
    ("PH", "Parker Hannifin", "Industrials"), ("USB", "U.S. Bancorp", "Financial Services"),
    ("EOG", "EOG Resources", "Energy"), ("PNC", "PNC Financial", "Financial Services"),
    ("APD", "Air Products", "Basic Materials"), ("FDX", "FedEx", "Industrials"),
    ("MCK", "McKesson", "Healthcare"), ("CSX", "CSX", "Industrials"),
    ("AON", "Aon", "Financial Services"), ("EMR", "Emerson Electric", "Industrials"),
    ("ECL", "Ecolab", "Basic Materials"), ("ORLY", "O'Reilly Automotive", "Consumer Cyclical"),
    ("MAR", "Marriott", "Consumer Cyclical"), ("NOC", "Northrop Grumman", "Industrials"),
    ("WELL", "Welltower", "Real Estate"), ("AJG", "Arthur J. Gallagher", "Financial Services"),
    ("COF", "Capital One", "Financial Services"), ("TFC", "Truist", "Financial Services"),
    ("CARR", "Carrier", "Industrials"), ("ADSK", "Autodesk", "Technology"),
    ("HLT", "Hilton", "Consumer Cyclical"), ("NSC", "Norfolk Southern", "Industrials"),
    ("SLB", "SLB", "Energy"), ("AZO", "AutoZone", "Consumer Cyclical"),
    ("GM", "General Motors", "Consumer Cyclical"), ("F", "Ford", "Consumer Cyclical"),
    ("ROP", "Roper Technologies", "Technology"), ("TRV", "Travelers", "Financial Services"),
    ("PSA", "Public Storage", "Real Estate"), ("AEP", "American Electric Power", "Utilities"),
    ("DLR", "Digital Realty", "Real Estate"), ("AFL", "Aflac", "Financial Services"),
    ("MET", "MetLife", "Financial Services"), ("O", "Realty Income", "Real Estate"),
    ("SRE", "Sempra", "Utilities"), ("KMB", "Kimberly-Clark", "Consumer Defensive"),
    ("GD", "General Dynamics", "Industrials"), ("OKE", "ONEOK", "Energy"),
    ("PCAR", "PACCAR", "Industrials"), ("SPG", "Simon Property", "Real Estate"),
]


def trading_days(end, years):
    days = []
    d = end - timedelta(days=int(years * 365.25) + 10)
    while d <= end:
        if d.weekday() < 5:
            days.append(d)
        d += timedelta(days=1)
    return days


def main():
    rng = random.Random(42)
    days = trading_days(END_DATE, YEARS)
    n = len(days)

    sectors = sorted({s for _, _, s in UNIVERSE})
    # daily factor returns: one market factor + one per sector
    market = [rng.gauss(0.0004, 0.009) for _ in range(n)]
    sector_f = {s: [rng.gauss(0.0, 0.006) for _ in range(n)] for s in sectors}

    HIST.mkdir(parents=True, exist_ok=True)
    members = []
    for sym, name, sector in UNIVERSE:
        beta = rng.uniform(0.7, 1.5)
        sbeta = rng.uniform(0.5, 1.2)
        drift = rng.gauss(0.0003, 0.0004)
        ivol = rng.uniform(0.006, 0.018)
        closes = []
        p = 100.0
        sf = sector_f[sector]
        for i in range(n):
            r = drift + beta * market[i] + sbeta * sf[i] + rng.gauss(0, ivol)
            p *= math.exp(r)
            closes.append(p)
        # rescale so the latest price lands somewhere plausible
        target = rng.choice([rng.uniform(20, 90), rng.uniform(60, 350), rng.uniform(200, 900)])
        k = target / closes[-1]
        closes = [round(c * k, 2) for c in closes]

        # momentum score over the 200 -> 20 trading-days-ago window
        w = closes[-WINDOW_FAR:-WINDOW_NEAR]
        ret = w[-1] / w[0] - 1
        rets = [math.log(w[i] / w[i - 1]) for i in range(1, len(w))]
        mean = sum(rets) / len(rets)
        var = sum((x - mean) ** 2 for x in rets) / (len(rets) - 1)
        vol = math.sqrt(var) * math.sqrt(252)
        score = ret / vol if vol > 0 else 0.0

        members.append({
            "symbol": sym, "name": name, "sector": sector,
            "score": round(score, 4),
            "ret": round(ret, 4),
            "vol": round(vol, 4),
            "price": closes[-1],
            "chg1d": round(closes[-1] / closes[-2] - 1, 4),
            "spark": closes[-30:],
        })

        with open(HIST / f"{sym}.json", "w") as f:
            json.dump({
                "symbol": sym,
                "dates": [d.isoformat() for d in days],
                "close": closes,
            }, f, separators=(",", ":"))

    members.sort(key=lambda m: m["score"], reverse=True)
    for i, m in enumerate(members):
        m["rank"] = i + 1

    with open(DATA / "screen.json", "w") as f:
        json.dump({"members": members}, f, separators=(",", ":"))

    with open(DATA / "meta.json", "w") as f:
        json.dump({
            "lastScreen": "2026-07-20T13:05:00Z",
            "lastUpdate": "2026-07-31T21:10:00Z",
            "pricesThrough": END_DATE.isoformat(),
            "window": {"far": WINDOW_FAR, "near": WINDOW_NEAR},
            "universeScanned": 1500,
            "members": len(members),
            "fake": True,
        }, f, indent=2)

    print(f"wrote {len(members)} members, {n} trading days each")


if __name__ == "__main__":
    main()
