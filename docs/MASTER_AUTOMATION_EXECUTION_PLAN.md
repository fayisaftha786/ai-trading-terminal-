# Master Automation Execution Plan — v0.7.2

## Current architecture and scope

The project has two distinct PAPER surfaces:

1. **Android Local PAPER:** Android app, public market data and a local virtual ledger. Manual entry and close require fresh quotes; stale cached prices fail closed.
2. **Cloudflare Free PAPER Worker:** dashboard, SQLite-backed Durable Object ledger, scheduled market scan and simulated exit monitor. Main configures a 90-second delay between cycles; a cache-busting production probe after PR #66 merge reported `schedule_seconds: 90`, but the first pending alarm was inherited from the prior 15-minute schedule.

The Cloudflare Worker is PAPER-only. Live exchange orders remain disabled. The older Python/FastAPI backend and Render deployment path are separate projects and are not the same runtime as this Worker.

## Market-data integrity

- Coinbase USD spot REST is the primary feed for BTC/USD, ETH/USD and SOL/USD.
- Bitstamp USD spot REST is the secondary provider for the same markets. A fallback uses the full same-provider ticker, order book, native 1H candles and native 6H candles.
- Ticker, book and both candle frames must all identify the same provider. No Coinbase quote is joined to Bitstamp candles, or vice versa.
- Bitstamp ticker must explicitly identify a SPOT market. Its order-book response must have a fresh exchange timestamp as well as a fresh local retrieval time. Coinbase REST book snapshots have no reliable exchange event timestamp, so only local retrieval age can be required there.
- Entry universe gates require fresh ticker observation/event time, a recent order-book retrieval (maximum 15 seconds), minimum top-10 depth of USD 5,000 on each side, valid spread, and at least 150 closed, contiguous and fresh candles on 1H and 6H for each configured market.
- If both providers fail or the secondary snapshot is incomplete, no new entries are allowed. Fresh bid marks may still be retained for PAPER exits when safe. Never use the secondary price to mark or close a position opened on the primary venue.
- Bitstamp candle archive rows have a separate provider key and are inserted incrementally. Offline strategy tournament continues using Coinbase-only archive data to avoid silent cross-venue blending.

## PAPER ledger, exits and risk

- Every PAPER trade records its entry data provider. Position valuation, simulated stops/targets, trailing exits and manual close are locked to that provider. Legacy positions without provenance are treated as Coinbase positions. If the entry provider is unavailable, the position is unmarked rather than valued against a different exchange.
- Initial virtual equity is USD 10; reserve USD 2; maximum position notional USD 8; one open position; up to five completed BUY→SELL cycles per UTC day. Entry risk is 1% of equity, daily loss guard 1%, weekly loss guard 4%, total drawdown stop 5%, and each symbol has a 4-hour cooldown.
- Simulated stop-loss is 1%; take-profit is dynamic and cost/ATR-aware. Estimated fees are 60 bps per side plus 10 bps slippage per side. Daily, weekly and overall drawdown limits are separate guards.
- Adaptive risk reduces position size as drawdown/loss streaks rise. Consecutive losses, data-quality streaks, stale scheduler heartbeat and total drawdown can latch-stop new entries.
- The kill switch disables new entries while scheduled monitoring continues. Reset requires no open PAPER positions and never silently turns auto-entry back on. A legacy starting-balance mismatch requires an explicit capital review after all positions are closed; this preserves the old virtual balance and historical trades, updates risk limits, and keeps auto-entry OFF.
- The 15-minute production / proposed 90-second exit monitor is simulated, not an exchange-native protective order. Gaps and outages can make simulated fills materially worse than the trigger.

## Current source and validation state

- Main Git commit at the 2026-11-09 audit: `ec1b48ec28205df092e8dc2a4ef9a39f28ca5ee4`.
- PR #62 (same-provider Bitstamp failover and provider diagnostics) is merged.
- PR #63 (lock PAPER position valuation and exits to the entry venue) is merged.
- Their GitHub validation pipelines passed syntax checks, unit tests, Wrangler dry-run and local Durable Object/authentication/kill-switch smoke coverage.
- Latest inspected production health sample at 2026-11-09 06:34:50 UTC: Worker API `ok`, mode `paper_only`, scheduler healthy, scheduled scan completed, 3/3 markets healthy, zero consecutive unhealthy scheduled scans, live trading OFF.
- That health response reported Worker version ID `346f39e4-a348-4168-8155-cea45fe53faf`, timestamp `2026-11-09T06:32:23.657091Z`, but `worker_version.tag` was blank. It therefore did not prove which Git commit was deployed after PR #63. The response's provider list was also empty; provider-level health telemetry is being strengthened separately.
- Android debug APK v0.7.1 is older than current source and is not production-signed. Physical installation on the owner's phone has not been verified.

## Cloudflare deployment verification

Workers Builds is already connected to the repository. In Cloudflare **Workers & Pages → ai-trading-terminal → Settings → Build**, set the Deploy command to:

```sh
npx wrangler deploy --tag "$WORKERS_CI_COMMIT_SHA" --message "Git commit $WORKERS_CI_COMMIT_SHA"
```

Cloudflare's Workers Builds documentation lists `WORKERS_CI_COMMIT_SHA` as a built-in build variable. The Worker exposes its deployed version tag through `CF_VERSION_METADATA`. After saving the Build setting, verify that a new production health response reports a tag matching the exact GitHub `main` SHA. The setting change applies to the next build; it does not retroactively tag an already deployed version.

Keep `ADMIN_PASSWORD` and `SESSION_SECRET` configured as Cloudflare runtime secrets. The owner must change them only through Cloudflare's secret manager; do not paste credentials into chat, issues or source code. The separate manual GitHub Actions deploy workflow requires GitHub repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; these are not required by the existing Workers Builds integration.

## Current market health vs scheduler heartbeat

The health response recalculates current market freshness from persisted snapshots on every request and reports it separately from the last completed scan and scheduled-alarm heartbeat. A recent alarm does not make an 11-minute-old ticker fresh; `market_data_status` may therefore be `unavailable` while `scheduler.status` is still `healthy`. The dashboard separately labels “Last scan markets” and “Current snapshots”. This prevents a previous 3/3 result from appearing to mean the current feed is still fresh. PR #65 adds this distinction and tests the initial no-snapshot state.

## What remains before optional PAPER auto-entry

1. Verify the merged main SHA is the deployed Worker version; configure the Workers Builds deploy tag if it is still blank.
2. Verify the pending alarm fires and subsequent scheduler cycles remain around 90 seconds apart.
3. Confirm the health endpoint reports all configured market/provider rows, including quote age, local book age, exchange book age where available, 1H/6H candle age, fallback reason and sanitized provider errors.
4. Confirm all three markets remain healthy over multiple consecutive scheduled scans—not merely one snapshot.
5. Confirm provider switching never changes the valuation venue of an open position, and that a position is marked unpriced rather than cross-marked when its entry venue is unavailable.
6. Verify ledger persistence, event history, kill-switch behaviour and scheduled alarm cadence after deployment.
7. Keep PAPER auto-entry OFF until every check passes. Enabling PAPER automation remains a separate explicit owner action and authorizes virtual trades only.

## Strategy research promotion rules

The current production entry path remains the conservative 1H trend-continuation strategy with 6H confirmation. Research hypotheses are diagnostics, not entry authorization:

- Trend pullback / EMA20 reclaim in a confirmed higher-timeframe uptrend.
- Volatility breakout above the prior 20-bar high with relative-volume and directional-strength confirmation.
- Range mean reversion with low ADX and confirmed Bollinger-band reclaim.

PR #66 adds a stronger offline research gate: at least 3,000 clean 1H and 500 clean 6H candles, an aligned higher-timeframe warmup, four chronological non-overlapping test folds of at least 28 days each, an untouched final holdout, per-strategy out-of-sample trade counts, 2x transaction-cost stress and a deterministic 500-path trade-order / moving-block Monte Carlo sensitivity test. The history requirement is roughly 125 days; until enough valid history accumulates, the app should show insufficient history rather than manufacture a walk-forward pass. Monte Carlo estimates from a small historical trade list are not forecasts and are sample-gated at 30 trades.

Before any research hypothesis is promoted, require look-ahead/prefix-invariance checks, recursive-indicator warmup stability, realistic spread/fee/slippage stress, regime and asset segmentation, and at least 30 calendar days of forward PAPER evidence with a meaningful sample. A strong backtest, clean CI run, or PAPER win streak does not establish future profitability. Do not add Martingale, unbounded DCA, unprotected grids or high leverage.

## Absolute guardrails

- No real-money orders, exchange withdrawal permissions, wallet signing in this Cloudflare Worker.
- Never request or store passwords, API tokens, wallet seeds or recovery codes in source files, APKs or chat.
- Never bypass stale-data, provider-consistency, depth, drawdown, scheduler or kill-switch gates to force automation.
- Do not claim 100% profit, live execution, physical Android installation or cloud deployment unless that exact behaviour has been verified.


## 2026-11-09 profit-protection audit

A review of the live PAPER exit path found a mismatch between trailing-stop activation and the dynamic take-profit target. The previous trailing stop activated at the greater of 2% or twice the estimated round-trip cost plus 0.75%. With the configured fee/slippage assumptions and ordinary spread, that activation threshold could be above the dynamic take-profit target, meaning the position would close at take-profit before the trailing stop ever became active.

The proposed fix on `fix/cost-aware-profit-trailing-stop` changes the trailing distance to a bounded 0.25%–0.60% based on estimated round-trip costs and activates after the high-water bid exceeds estimated costs + trail distance + a 0.20% net buffer. The stop remains ratchet-only and never loosens. A regression test uses 165 bps round-trip costs and verifies that the stop activates before the modelled take-profit and sits above the estimated cost break-even.

This is a PAPER risk-management improvement, not proof of profitability. It does not guarantee a fill at the simulated stop, prevent gaps/slippage, or enable live exchange execution. The change must pass CI and be deployed/verified before being considered active in production.
