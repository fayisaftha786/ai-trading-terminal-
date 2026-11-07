# Automatic paper-trading design — v0.3.9

## Scope and operating boundary

Automatic execution is restricted to CEX spot long-only **paper simulations**. No production order is transmitted, and this engine cannot move real funds. The separately gated Binance Spot Testnet workflow is explicit/manual and isolated from automatic strategy decisions and paper P&L. Solana is discovery/screening only.

## Decision pipeline

1. Fetch public CCXT tickers for the configured spot watchlist.
2. Require a live exchange timestamp within 120 seconds, finite/nonzero last/bid/ask, a non-crossed quote and spread no wider than 25 bps.
3. Fetch top-10 order-book depth. Fail closed when depth is unavailable, older than 15 seconds, negative, or either side has less than 5,000 quote units. If the exchange omits a book timestamp, only local retrieval time is available and the weaker provenance is recorded.
4. Require at least 1,000,000 quote-volume units over 24h and a USD-like quote asset (USD/USDT/USDC/FDUSD).
5. Fetch primary 1h and confirming 4h OHLCV. Exclude candles that are not fully closed. Require the last closed 1h bar to be no older than 90 minutes and the 4h bar no older than 5 hours.
6. Audit the raw closed bars before analysis: malformed OHLCV, duplicate timestamps, UTC off-grid timestamps, non-integral interval spacing and missing bars fail closed. A failure forces `HOLD` and blocks historical replay.
7. Require at least 150 valid unique closed bars for indicators; primary score >= 75; 1h and 4h regimes both `UPTREND`; aligned timeframes; RSI < 68; ATR < 5%; ADX >= 18; and +DI > -DI.
8. Require the estimated expected ATR range to exceed 2.5x estimated round-trip fee, slippage and observed spread costs.
9. Require no same-symbol open trade, a four-hour symbol cooldown, at most three automatic entries per UTC day and at most one entry per scan.
10. Validate the current persisted risk profile. Apply fee/slippage-inclusive sizing, max exposure/position count, daily and weekly net-equity limits, no-unmarked-position checks and observed peak-to-trough drawdown protection.
11. Simulate entry at ask plus configured slippage, charge entry fee and persist decision evidence, signal metrics and execution assumptions in SQLite.
12. During scans, mark open CEX paper positions from fresh bid/last data, apply stop/target triggers, estimate fee/slippage-inclusive unrealized equity and monitor portfolio drawdown.

## Indicator and signal interpretation

The deterministic analyzer uses SMA-seeded EMA20/50, Wilder RSI14/ATR14/ADX14, +DI/-DI, EMA20 slope, closed-bar 20-period relative volume, 20-bar breakout and a volatility regime. The score is a rule score, **not a probability** and not a forecast. A `BUY_CANDIDATE` is only a research candidate; the automation engine applies additional market-quality and portfolio-risk gates. Missing warm-up history or a failed integrity check results in `HOLD`.

## Circuit breaker and exits

When observed peak-to-trough drawdown reaches the configured threshold, the engine closes open paper positions for which it has a fresh mark, disables new automatic entries and records an audit event. An open position without a fresh mark blocks new entries; the engine does not invent an exit price. Invalid persisted entry-risk settings block new entries, but do not disable exit monitoring. If fee/slippage settings are corrupt, exit valuation uses bounded conservative cost assumptions.

The kill switch disables new entries. If CEX paper positions remain open, the scan worker stays available to monitor their stop/target exits. Stopping or suspending the cloud service means the app cannot monitor automated exits while offline.

## Idempotency and restart behavior

- Same-symbol duplicate open positions are rejected in application logic and by a SQLite partial unique index, including concurrent entry races.
- UI-initiated and scheduled scans are serialized; close requests use an immediate SQLite write transaction and a conditional state transition.
- Feed inputs must be finite; malformed, stale, crossed or missing market data fails closed.
- Entry sizing uses the slippage-adjusted simulated ask price and includes both-side fee/slippage in its risk budget.
- The daily entry cap, cooldown evidence, events and paper ledger persist in SQLite.
- Automatic paper entry opt-in is process-local and starts OFF after every backend restart. If CEX paper positions remain open, the read-only exit monitor can resume without re-enabling entries. Solana exit monitoring is not auto-resumed because a dedicated reliable mark feed is not implemented.
- Trade metadata records mode, signal score, regime, higher-timeframe regime, spread, volume and quote timestamps.

## Strategy-aligned research

The strategy replay and walk-forward use closed 1h and 4h candles, the same primary indicator predicates and higher-timeframe trend confirmation, next-1h-open entries, both-side fees/slippage, four-bar same-symbol cooldown, three-entry-per-UTC-day cap and conservative stop-first handling when both stop/target are touched in one OHLC bar. Research endpoints use the saved server-side risk profile; callers cannot override cost or risk settings. The report includes a same-max-exposure buy-and-hold comparator, sequential non-overlapping windows and 1x/1.5x/2x cost stress. A stressed scenario blocks new entries when the estimated net reward/risk falls below 1:1.

The older EMA20/50 crossover endpoint is a **separate comparator**, not validation of the current auto-paper strategy. The new strategy replay still cannot reconstruct historical spread, depth, ticker freshness, quote-volume quality, queue position, latency, partial fills, market impact or actual exchange fills. Walk-forward on a limited fetched history is not a final untouched holdout or a statistically powered result.

## Known measurement and modelling gaps

- Paper fills are approximate; queue priority, partial fills, exchange rejections, latency, outages, market impact and venue maintenance are not simulated.
- Stop/target decisions are candle-based for research. Intrabar path is unknown; if both are touched, the conservative stop-first assumption is used.
- Daily/weekly net-equity baselines initialize on the first fully marked observation of each UTC period. If the app was offline before that observation, earlier intraperiod unrealized movement cannot be reconstructed.
- Peak-equity protection is observation-based, not an exchange-native guaranteed stop. No scan means no monitoring.
- The rule score is deterministic and uncalibrated. No trained ML model, probability calibration, portfolio correlation optimizer or complete order-book simulator is included.
- The Solana path does not simulate signed swaps, MEV or automatic exits and is not eligible for automatic entry.

## Forward evidence and release gates

`/api/performance` uses the closed paper ledger and observed equity snapshots; it is not a live performance statement. Require at least 30 calendar days of forward paper operation and a meaningful sample (target 200 trades where opportunities permit), multiple assets/regimes, no ledger mismatch, realistic fill comparisons and verified kill-switch/restart behavior before considering any further execution stage. A good backtest, Testnet fill or passed unit test does not prove positive future returns.

For a real-money release, require separate jurisdiction/provider eligibility review, security/authentication architecture, independent secrets review, trade-only keys with withdrawals disabled, private-order/balance reconciliation, exchange-native protective orders, chaos/integration tests, independent emergency stop, caps, and explicit user approval. Production stays hard-locked with HTTP 423.
