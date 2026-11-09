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

- Coinbase USD spot remains primary; Bitstamp is a complete same-venue secondary snapshot.
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

- Cloudflare Worker: PAPER only. Live exchange orders and Binance Testnet execution remain disabled.
- Auto PAPER entry: defaults OFF and requires a separate owner opt-in after a fresh complete scheduled scan.
- Market universe: BTC/USD, ETH/USD and SOL/USD.
- Signal: deterministic 1H trend continuation with 6H confirmation; other strategy families remain research-only.
- Exit: simulated on a Durable Object alarm; no guarantee of exact trigger-price fills.
- 90-second cadence: proposed in PR #66, not yet confirmed in production.
- Android v0.7.1 debug APK is older than the Cloudflare source and has not been physically installed/verified in this workflow.
- PR #66 GitHub checks are being run independently of Cloudflare Workers Builds. The Cloudflare branch-build check currently fails without accessible logs; production deployment is not claimed.

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
