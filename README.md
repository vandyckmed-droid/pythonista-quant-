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

UI is complete and running on **generated sample data** shaped exactly like the
real pipeline output (`scripts/make_fake_data.py`). The live FMP data pipeline
(screen + update scripts writing `data/`) is the next step.

## Layout

```
index.html, css/, js/     the app (vanilla JS, no build step)
data/meta.json            refresh timestamps + screen parameters
data/screen.json          ranked member list with summary stats
data/history/{SYM}.json   5y of daily adjusted closes per member
scripts/                  data generation (sample now, FMP pipeline next)
```

Deployed automatically to GitHub Pages on every push to `main`.
