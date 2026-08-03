# Momentum Screener

Personal momentum stock screener. Static site on GitHub Pages — no server, iPhone-first.

## How it works

Two manually triggered refreshes:

- **Screen** (every 1–4 weeks): ranks ~1500 of the largest US equities by
  return ÷ volatility over the window 200 → 20 trading days ago (adjusted closes).
  Keeps the top 150 with hysteresis: a name enters at rank ≤ 150 and stays until
  it drops below 195. New entrants get 5 years of daily history stored.
- **Update** (roughly daily): members only. Catches up all prices since the last
  run and recomputes charts, correlations, and risk numbers.

The app has three views:

- **Screen** — the ranked 150, sortable, with sparklines; tap a row for detail,
  tap ☆ to watchlist a name.
- **Watchlist** — risk analysis on selected names using the stored 5-year
  history: correlation matrix, effective number of bets (ENB), and
  hierarchical-risk-parity (HRP) weights. Computed in the browser.
- **Detail** — scrubbable price chart (1M–5Y) and fuller stats per name.

## Current status

Live. `data/` holds real FMP end-of-day data. Refreshes are run by hand from
the GitHub Actions tab (both need the `FMP_API_KEY` repository secret):

- **Screen (rebuild the 150)** — the wide screen; run every 1–4 weeks.
- **Update (refresh prices)** — members-only price catch-up; run whenever.

Each workflow commits the refreshed `data/` to `main` and republishes the site.
`scripts/make_fake_data.py` remains for UI work on sample data.

## Layout

```
index.html, css/, js/     the app (vanilla JS, no build step)
data/meta.json            refresh timestamps + screen parameters
data/screen.json          ranked member list with summary stats
data/history/{SYM}.json   5y of daily adjusted closes per member
scripts/fmp.py            shared FMP API helpers (stdlib only)
scripts/screen.py         the wide screen -> membership, ranks, 5y histories
scripts/update.py         members-only price catch-up
```

Deployed automatically to GitHub Pages on every push to `main`.
