# Momentum Screener

A personal momentum stock screener, built as a static site — no server, iPhone-first.

**Live app:** https://vandyckmed-droid.github.io/pythonista-quant-/

Data source: Financial Modeling Prep (FMP), end-of-day prices.

## How the list is built, step by step

1. **Start with the big pool.** Ask FMP for every actively traded US company stock
   worth at least $1 billion on the NYSE, NASDAQ, or AMEX (~2,100 tickers).
2. **Throw out the junk.** Remove funds, trusts, blank-check shells, and oddball
   tickers. When one company has two ticker symbols (GOOG/GOOGL), keep only the
   bigger one so no company appears twice.
3. **Cut to the 1,500 largest** by company value. That's the universe being judged.
4. **Measure momentum.** For each stock, look at its price journey from ~10 months
   ago to ~1 month ago (trading days 200 back to 20 back, dividend-adjusted).
   Two numbers come out: how much it gained, and how bumpy the ride was. The score
   is **gain ÷ bumpiness** — a smooth 60% beats a violent 80%. The most recent
   month is deliberately ignored because recent-month moves tend to reverse.
5. **Rank everyone** by that score, best first. (Stocks without enough price
   history to judge fairly — very recent IPOs — are dropped here.)
6. **Apply the "sticky door" rule.** The top 150 get in, but an existing member
   isn't kicked out until it falls below rank 195. This stops names from bouncing
   in and out on tiny rank changes, and it's why the member count hovers slightly
   above 150 rather than hitting it exactly.
7. **Stock the pantry.** Every member gets 5 years of daily adjusted prices
   stored, powering the charts and the watchlist risk math instantly. Names that
   leave the list have their stored history removed.

## The two refreshes (both manual, from the Actions tab)

Both need the `FMP_API_KEY` repository secret, and both commit the refreshed
`data/` to `main` and republish the site automatically.

- **Screen (rebuild the 150)** — runs all the steps above. Run every 1–4 weeks.
  This is the only refresh that changes membership or ranks. Takes ~10 minutes.
- **Update (refresh prices)** — members only. Catches up every price since the
  last run (skipped days never leave gaps) and refreshes charts and stats. If a
  stock splits or its adjusted prices shift, its full history is re-downloaded.
  Run roughly daily, after US market close. Takes under a minute.

## The app

- **Screen** — the ranked members, sortable, with sparklines; tap a row for
  detail, tap ☆ to watchlist a name.
- **Watchlist** — risk analysis on your selected names using the stored 5-year
  history: correlation matrix, effective number of bets (ENB), and
  hierarchical-risk-parity (HRP) weights. Computed in the browser; the watchlist
  itself is saved on the device.
- **Detail** — scrubbable price chart (1M–5Y) and fuller stats per name.

The header always shows when the list was last formed and how fresh prices are.

## Repo layout

```
index.html, css/, js/     the app (vanilla JS, no build step)
data/meta.json            refresh timestamps + screen parameters
data/screen.json          ranked member list with summary stats
data/history/{SYM}.json   5y of daily adjusted closes per member
scripts/fmp.py            shared FMP API helpers (stdlib only)
scripts/screen.py         the wide screen -> membership, ranks, 5y histories
scripts/update.py         members-only price catch-up
scripts/make_fake_data.py sample-data generator, for UI work without the API
.github/workflows/        the two refresh buttons + site deploy (gh-pages)
```
