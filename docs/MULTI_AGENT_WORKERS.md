# Multi-worker market analysis

## What is implemented

The dashboard exposes a fixed registry of 12 specialist workers. A user starts a run from the Workers panel. The backend fetches one market snapshot (closed primary and confirmation-timeframe OHLCV candles), then fans that immutable snapshot out to specialist functions.

These are deterministic Python analysis workers, not 12 separate trained AI/LLM models. No paid model API is required for the implemented workers.

| Worker | Responsibility | Current source |
|---|---|---|
| Market Data & Integrity | Provider, closed candles, contiguous data and history quality | CCXT / MarketDataService |
| Trend Analyst | EMA trend, ADX and higher-timeframe context | analyze_candles |
| Momentum Analyst | MACD, histogram slope and ROC | analyze_candles momentum diagnostics |
| Volume Analyst | Recent/prior closed-bar volume ratio | analyze_candles |
| Multi-Timeframe Analyst | Primary vs confirmation timeframe confluence | MarketDataService |
| Breakout & Range Analyst | Prior 20-bar support/resistance and range break | Closed OHLCV candles |
| Volatility Analyst | ATR and approximate realized volatility | analyze_candles |
| News & Sentiment Analyst | News/social sentiment | UNAVAILABLE — no provider or sentiment model is configured |
| Strategy Reviewer | Existing deterministic strategy output and reasons | analyze_candles |
| Risk Guard | Read-only risk-profile, integrity, history, alignment and volatility preflight | validate_risk_profile |
| Research Readiness | Checks history/integrity prerequisites for backtesting | Existing candle snapshot |
| Portfolio & Paper Monitor | Open paper positions and portfolio exposure snapshot | SQLite paper ledger |

The Research Readiness worker checks prerequisites only; it does not pretend to have run a backtest. The Portfolio & Paper Monitor reads the ledger; actual stop/target monitoring remains in the existing automation scheduler.

## API

- GET /api/workers — registry, availability, last-run health and bounded concurrency.
- GET /api/workers/analyze/{symbol}?timeframe=1h&limit=300 — runs the 12 specialist diagnostics for one CEX market.

Supported timeframes are 1m, 5m, 15m, 30m, 1h, 2h, 4h, and 1d. Candle limits are bounded from 60 to 1000.

## Runtime controls

- At most four worker handlers execute at once, including concurrent analysis requests.
- Each handler has a four-second timeout and at most one bounded retry after an exception/timeout.
- A faulty worker is isolated; other worker results are still returned.
- Worker outputs expose complete, blocked, unavailable, or error states with attempts and duration.
- The registry retains the latest in-process run status for health visibility. It is not a durable event history.
- The API fetches market data once per run, not once per worker.

## Safety boundary

This worker system is diagnostic and read-only. execution_authorized and live_trading_enabled are always false in its results. It does not call the Testnet order service, production order endpoints, or paper broker. It does not change the current BUY_CANDIDATE rules or enable automatic paper trading. Existing candle integrity, quote freshness, spread/depth and portfolio risk gates remain the owners of paper-entry decisions.

Live-money order execution remains hard-disabled. Testnet remains separately gated. No profit or prediction guarantee is made.

## Not yet implemented

- Connected licensed news/social feeds and a validated sentiment model.
- Model-based agents or agent-to-agent LLM reasoning.
- Persistent worker job queues or independent 24/7 worker processes.
- Automatic use of worker consensus as a paper/live trade authorization.

Those items require separate providers, validation, infrastructure and safety review. This first implementation is on-demand parallel analysis in the existing single-instance backend, compatible with the current SQLite and single-Uvicorn-worker architecture.
