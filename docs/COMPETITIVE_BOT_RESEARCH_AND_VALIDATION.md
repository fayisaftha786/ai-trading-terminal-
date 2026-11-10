# Competitive Bot Research and Validation Plan

## Decision

The goal is not to copy a commercial bot's number of indicators or to promise higher profit. The engineering target is a paper-trading system that makes fewer unsupported decisions, explains why it did or did not enter, and stays safe when market data or the scheduler fails.

This document compares patterns from Freqtrade, Hummingbot, Jesse, 3Commas and Cornix. It distinguishes reusable engineering ideas from strategies or marketing features that should not be copied.

## What the other systems do well

| System | Useful strengths | What to adopt here |
|---|---|---|
| Freqtrade | Dry-run, backtesting, look-ahead analysis, recursive-indicator analysis, protections and explicit stop configuration | Prefix-invariance tests, startup-window sensitivity diagnostics, clear fail-closed protection states |
| Hummingbot | Controller/executor separation, unified market-data providers, explicit executor lifecycle and monitoring | Separate market-data, candidate, PAPER-position and exit responsibilities; retain auditable state transitions |
| Jesse | Multi-timeframe research, held-out testing, Monte Carlo trade/candle experiments and rule-significance checks | Chronological out-of-sample testing, cost stress, bootstrap sensitivity and honest sample-size reporting |
| 3Commas | DCA/grid configuration, capital controls, trailing/TP/SL controls and signal workflows | Borrow useful presentation and risk-budget ideas only; these are not proof of a strategy edge |
| Cornix | Signal-to-order workflow and configurable DCA/TP/SL handling | Keep signal evaluation separate from simulated position management; never turn a signal into an order without a separate risk gate |

Sources are listed at the end. Vendor feature descriptions are not evidence of profitability.

## Features adopted in the current hardening branch

### Market data and recovery

- Coinbase USD spot is the sole live market source for new paper entries. Bitstamp is isolated to legacy same-venue exit marking and explicit historical research backfill.
- A market snapshot may not blend ticker, order book, 1H candles or 6H candles across providers.
- PAPER positions remain locked to their entry provider for valuation, simulated exits and manual close.
- Health distinguishes scheduler heartbeat, last completed scan and current snapshot freshness.
- A scheduled alarm waits for an in-flight manual scan rather than counting the manual scan as the scheduled result.
- The proposed 90-second alarm cadence better fits the 120-second quote freshness limit. Production is still on its prior cadence until Cloudflare deployment is verified.
- A 90-second simulated monitor is still not an exchange stop; a fast gap can occur between checks.

### Research and anti-overfitting

- Strategy backtests use next-bar-open entries, include estimated fees and slippage, resolve same-bar stop/target conflicts stop-first, and include estimated exit costs in equity marks.
- Research now requires at least 3,000 clean 1H and 500 clean 6H bars for four chronological, non-overlapping test folds of at least 28 days each, after higher-timeframe warmup.
- The final fold is an untouched holdout. Out-of-sample trade counts are visible; fewer than 30 aggregate test trades is explicitly labelled an insufficient research sample.
- A deterministic 500-path trade-order shuffle and moving-block bootstrap reports sensitivity of returns and drawdown to trade sequencing. It is a resampling diagnostic, not a forecast or calibrated probability.
- Recursive warmup analysis compares indicator values and strategy signals across different startup-history lengths.
- Prefix-invariance tests ensure that candles strictly after a fixed evaluation cutoff do not change the historical decisions before that cutoff.

These checks do not certify a strategy. The archive must accumulate roughly 125 days of clean 6H/1H history before the strict walk-forward gate can become available; until then the correct result is “insufficient history”.

## What we deliberately reject

- Martingale or unbounded DCA: repeated averaging can grow exposure precisely when the initial thesis is failing.
- Unprotected grids: a range-bound backtest can hide inventory accumulation during a persistent trend.
- High leverage and tight scalping on a 90-second polling monitor: the current execution model is too slow and is not exchange-native.
- “Best parameter wins” optimization without an untouched holdout and multiple-testing awareness.
- Black-box AI/FreqAI-style signal generation in the production entry path before there is enough clean, labelled, venue-consistent data and a defensible out-of-sample evaluation process.
- Treating a backtest, Monte Carlo run, testnet fill or paper win streak as a profit guarantee.

## Promotion checklist for any new strategy

1. Candle input is validated for OHLCV integrity, timestamp alignment, duplicates, gaps and closed-bar status.
2. Prefix-invariance and look-ahead tests pass.
3. Indicator values and signals are reasonably stable across startup-history lengths, or sensitivity is explicitly disclosed.
4. There is sufficient chronological history for non-overlapping walk-forward folds and an untouched final holdout.
5. Results show per-fold trade count, net return, profit factor, expectancy, exposure, maximum drawdown and stop/target conflict rate.
6. Fee, spread and slippage assumptions are stressed at 1x, 1.5x and 2x. Venue-specific histories are kept separate.
7. Monte Carlo trade-order and block-bootstrap diagnostics are reported only when there are at least 30 observed trades; low samples remain inconclusive.
8. Every strategy completes at least 30 calendar days of forward PAPER observation and a meaningful trade sample before it can be considered for a separately reviewed paper-entry change.
9. It never bypasses global data quality, position-provider locking, portfolio risk, cooldown, drawdown, scheduler or kill-switch controls.

## Current boundaries

- This branch is PAPER-only for strategy automation. The Coinbase live-order route remains hard-locked with HTTP 423; no real order can be submitted from the automated strategy.
- Fresh empty PAPER ledgers use a $10 virtual balance, one open position, an $8 notional ceiling (leaving $2 unallocated), and no more than five position openings per UTC day. Five is a hard ceiling, not a target.
- New empty ledgers automatically start PAPER monitoring after the Durable Object alarm is initialized. The alarm runs a periodic 90-second scan/exit-monitor cycle; this is not a continuously running process, tick feed, or exchange WebSocket stream.
- Three consecutive unhealthy scheduled scans pause new entries. The watchdog clears its market-data halt after two consecutive complete healthy scheduled scans, but it restores auto-entry only if the owner’s prior opt-in permission was explicitly persisted before the watchdog halt. Owner emergency stops and total-drawdown halts require explicit owner review and do not auto-resume.
- Exits are simulated against fresh same-provider bid marks on a scheduled alarm; exact stop/target fills are not guaranteed. A network outage or stale quote can delay simulated exit detection.
- The daily hard loss guard is 1% of the initial paper capital ($0.10 at $10), with a 75% soft pause ($0.075). These are simulation limits, not a cap on possible live-market loss.
- Fee-aware sizing currently uses a conservative 60 bps/side paper fee placeholder, 10 bps/side slippage and the observed spread. It is not the account's verified Coinbase tier.
- Automatic target selection compares the estimated round-trip costs, a fraction of the 1H ATR and a 1% minimum gross move; it rejects targets above 5%. This is a deterministic risk heuristic, not a prediction or probability.
- Market decision data includes validated closed 1H/6H candles, EMA20/EMA50 trend, RSI14, ATR14, ADX14, directional movement, volume context, fresh quote, spread, order-book depth and provider consistency. The 1M/5M scanner remains research-only.
- Not included as a production signal source: trained ML forecasts, news/sentiment, social/on-chain flows, tick-level order-book stream or exchange-native protective orders.
- PR #66 changes are not production-deployed by this update. The Android v0.7.1 debug APK is older than the Cloudflare source and has not been physically installed/verified in this workflow.
- CI and local Cloudflare Worker smoke tests must pass before merge/deploy. No production deployment is claimed.

## Official references

- Freqtrade documentation: https://www.freqtrade.io/en/stable/
- Freqtrade look-ahead analysis: https://www.freqtrade.io/en/stable/lookahead-analysis/
- Freqtrade recursive analysis: https://www.freqtrade.io/en/stable/recursive-analysis/
- Hummingbot V2 strategy architecture: https://hummingbot.org/strategies/v2-strategies/
- Hummingbot executors: https://hummingbot.org/strategies/v2-strategies/executors/
- Jesse research and optimization: https://docs.jesse.trade/docs/research/optimize
- 3Commas Grid Bot guide: https://help.3commas.io/en/articles/16281082-how-the-grid-bot-works-strategy-setup-guide
- Cornix Smart DCA guide: https://help.cornix.io/en/articles/6164330-create-your-own-smart-dca-bot
- Probability of Backtest Overfitting (Bailey et al.): https://doi.org/10.21314/jcf.2016.322
- Coinbase Exchange REST rate limits: https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits
- Cloudflare Durable Object alarms: https://developers.cloudflare.com/durable-objects/api/alarms/
- Cloudflare Durable Objects platform limits: https://developers.cloudflare.com/durable-objects/platform/limits/

## Micro-scalping research gate (1m / 5m)

The dashboard now includes a read-only micro-scalping research gate. It uses validated,
fully closed 1-minute candles for a breakout/relative-volume trigger, a closed 5-minute
trend setup, and 1H/6H context. Ticker, order-book and both candle timeframes must have
fresh timestamps and matching exchange provenance. Missing, stale, discontinuous or
mixed-provider inputs fail closed to `NO_TRADE`.

The default research cost model is deliberately conservative: 60 bps taker fee per
side, 10 bps slippage per side, plus the observed full bid/ask spread. This is a
placeholder assumption, not the user's verified Coinbase tier. The model requires
the ATR-derived gross target to exceed round-trip costs by at least 1.5x and leave a
positive minimum estimated net edge. These ATR values are screening estimates, not
forecasts, fills or measured returns.

1m and 5m closed candles are archived separately from the 1H/6H strategy archive.
1m retention is 4,320 bars; 5m retention is 2,000 bars. The gate is intentionally not
connected to PAPER auto-entry or any live order endpoint. It is surfaced only as
`RESEARCH_CANDIDATE` or `NO_TRADE`.

**Execution limitation:** the scheduled Worker scanner polls on a 90-second cadence.
It is not an exchange WebSocket feed, does not observe every trade/book event, and
cannot safely promise repeated one-minute fills or exchange-native protective orders.
Before any micro-scalp PAPER execution is considered, build a persistent real-time
market-data path and a separate fill simulator that accounts for queue position,
partial fills, spread, market impact, latency, and stop/target ordering. Require
chronological out-of-sample validation and forward paper observation; never promote
based on a small profitable sample alone.

## Coinbase Advanced live-readiness adapter (locked)

The Cloudflare Worker now has a separate Coinbase Advanced Trade v3 adapter for
authenticated account preflight and exchange-side order preview. It uses CDP
ECDSA P-256 / ES256 JWT authentication and exact method + host + request-path
binding. The private key is read only from Worker environment secrets; it is not
stored in Durable Object SQLite, returned to the browser, or written to logs.

Required Cloudflare configuration (set only in the Cloudflare Worker secrets/vars UI):

- `COINBASE_ADVANCED_API_KEY`: CDP API key name.
- `COINBASE_ADVANCED_API_SECRET`: CDP ECDSA P-256 PEM private key.
- `COINBASE_ADVANCED_ALLOWED_PRODUCTS`: explicit comma-separated product IDs
  that the account owner has checked are available to their own account.
- `COINBASE_ADVANCED_MAX_ORDER_QUOTE`: explicit maximum quote-currency amount
  permitted for a preview request.

The preflight verifies `can_view=true`, `can_trade=true`, and
`can_transfer=false`; account pagination; available quote-currency balances;
and SPOT product status, tradability, increments and size limits. The order
preview is BUY / LIMIT GTC / post-only and displays the exchange previewed
commission, bid/ask, slippage, warnings and errors. No product IDs or amounts
are assumed until configured and confirmed by the account API.

**Hard boundary:** this build does not call `POST /api/v3/brokerage/orders`
and contains no live order-submission route. `POST /api/live/execute` returns
HTTP 423. Auto-live entries and transfers remain disabled. An order preview is
not an order, reservation, fill, or execution guarantee.

Before implementing submission, the system still needs a verified account-
specific product and jurisdiction check, a stable/approved API-key network
allowlist strategy, a real-time Advanced Trade WebSocket market-data path,
private user-order stream reconciliation, durable order-intent/idempotency
journal, cancel/replace and unknown-submission recovery, exchange-native
protective exit design, and independent operator kill-switch tests. The
existing 15-minute production scanner is demonstrably too slow for these
requirements; even the 90-second PR cadence is not a real-time feed.

Do not paste Coinbase keys into chat, GitHub, screenshots, or the dashboard.
Use Cloudflare secret storage only. Do not enable transfer permission.


## Coinbase guarded live-order integration (manual-confirm phase)

The Coinbase Advanced Trade v3 adapter supports a deliberately narrow real-order path:
- CDP key permissions must report View + Trade and Transfer=false.
- Only explicitly allowlisted SPOT products are accepted.
- Orders are BUY / LIMIT / GTC / post-only; market orders, withdrawals and automatic strategy-driven live entries are not enabled.
- The owner must preview first and then explicitly confirm the exact preview with a unique client order ID.
- Per-order quote cap, max-open-order cap and persistent daily order-count cap are checked before submission.
- Order attempts are persisted before the network call. Ambiguous timeouts are marked UNKNOWN and must be reconciled by client order ID before retrying.
- Reconciliation and cancel endpoints expose exchange status; an accepted order is not considered a fill.
- Fill-level accounting and daily realized-loss automation are not yet complete. Therefore automatic live entries remain OFF and this phase is not unattended/fully automated trading.

Required Cloudflare secrets/vars are listed in .env.example. Keep COINBASE_ADVANCED_ORDER_ENABLED=false until the account's Advanced Trade API is eligible and the owner has independently reviewed limits. Never enable Transfer permission or put private keys in Git, browser storage, or chat.


## Continuous small-capital PAPER automation profile

The small-capital profile is implemented in `src/paper-automation-profile.js` and wired into the Durable Object engine. It preserves historical paper ledgers: an old $100 ledger containing trades is not silently rebased to $10; it is paused for owner review. An empty legacy ledger can migrate safely to the $10 profile. The dashboard exposes the schedule heartbeat, current halt reason, daily opening count and remaining allowance.

Automation is periodic, not a daemon that holds a process open continuously. The Durable Object alarm fetches public market data and evaluates existing paper exits and new entries every 90 seconds. It reschedules itself after each invocation, including handled scan failures. Cloudflare platform availability, worker errors and external data-provider downtime can still interrupt this loop. Open paper positions are only checked when a fresh compatible market snapshot is available.

The decision engine is a transparent indicator/rule system rather than a trained ML model. A score is a rule score, not a probability of profit. News, sentiment, social activity, on-chain flows and real-time WebSocket order-book pressure are not currently part of the entry decision. The 1M/5M micro-scalping module remains research-only and is deliberately not connected to automatic position creation.
