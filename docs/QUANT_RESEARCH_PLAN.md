# Quantitative research and analysis-bot plan (current implementation v0.3.9)

## Objective and honest boundary

The objective is not to promise a guaranteed return. It is to improve the probability that a strategy has positive net expectancy after realistic costs while bounding drawdowns, detecting when its edge disappears, and refusing trades when evidence is weak. A strategy can lose money even when every component works as designed.

The current product remains a paper-trading research terminal. No private exchange credentials, wallet seed phrase, Solana signer, or live order route is present. Do not enable live trading based on a good backtest alone.

## Research principles

1. **Net economics before prediction accuracy.** Every candidate signal must beat fees, bid/ask spread, slippage, priority/funding costs where applicable, and a conservative market-impact allowance.
2. **Chronological evaluation.** Never randomly shuffle time series. Use an initial warm-up, sequential non-overlapping test windows, and a final untouched holdout.
3. **No look-ahead.** A signal calculated from candle close `t` may not fill at that same close in a realistic backtest; the v0.2 baseline uses the next candle open.
4. **No repeated test-set tuning.** Record every tested parameter set. If many variants are tried, account for multiple testing and selection bias.
5. **Regime conditionality.** Measure results separately in uptrend, downtrend, range, high-volatility, low-liquidity and stressed conditions. The system must be able to return `NO_TRADE`.
6. **Independent risk control.** Strategy/AI agents cannot change risk limits, wallet permissions or live mode.
7. **Evidence, not dashboard decoration.** Every signal stores source timestamp, receive timestamp, feature values, strategy version, decision reasons and eventual simulated fill.

## Market intelligence layers

### A. Data integrity and freshness

- Persist exchange, symbol, timeframe, source timestamp, receive timestamp and raw/normalized payload hash.
- Reject stale, duplicated, out-of-order, malformed and incomplete OHLCV bars.
- Track missing bars, provider outages, rate-limit responses, clock drift and reconnect events.
- Reuse exchange clients, respect per-endpoint rate limits and apply bounded retries with exponential backoff.
- Compare price feeds for major assets where feasible; flag material divergences instead of averaging blindly.

### B. Multi-Crypto features

- Trend: EMA 20/50/200 alignment and slope; higher-timeframe confirmation.
- Momentum: RSI, MACD histogram, rate of change and breakout persistence.
- Volatility: ATR%, realized volatility, range expansion and volatility regime.
- Participation: quote volume, relative volume and volume-confirmed breakouts.
- Microstructure: bid/ask spread, top-of-book depth, depth imbalance, order-book update age and estimated market impact.
- Cross-asset context: BTC trend/volatility, ETH/BTC relative strength, SOL/BTC relative strength and rolling correlations.
- Cost-aware decision: expected move must exceed estimated round-trip costs plus a safety margin.

### C. Solana token intelligence

- Token mint address is the identity; ticker/name are display-only.
- Discover through current Jupiter Tokens API V2 endpoints and verify schema version/fields.
- Require current mint/freeze authority status, suspicious/banned flags, top-holder concentration and token-program/extension checks.
- Inspect pool reserves, liquidity depth, quote impact, route quality, recent swaps and holder concentration changes.
- Obtain a fresh swap quote for the exact mint/amount and reject stale quotes, excessive price impact, route/program mismatches and unknown fees.
- Do not equate token verification or an organic score with safety. A token can still be manipulated or lose liquidity.
- Treat discovery endpoints as discovery only; never use discovery metadata as a live mark price or proof of an executable fill.

### D. Signal and portfolio decision

- Begin with explainable deterministic baselines; add ML only if it beats baselines out-of-sample after costs.
- Generate a calibrated confidence estimate only after probability calibration on strictly historical training windows. Until then, expose a score, not a probability.
- Combine signal quality with execution feasibility, liquidity, volatility, correlation and portfolio exposure.
- Use `NO_TRADE` when confidence/economic edge is insufficient, data is stale, costs are too high, or the market regime is outside validated conditions.
- Apply cooldowns and avoid duplicate correlated positions.

## Strategy research workflow

1. Freeze a hypothesis and feature definition before testing.
2. Build a benchmark (buy-and-hold for spot, cash/no-trade baseline, and simple trend baseline).
3. Include realistic fees, spread, slippage, partial fills, latency and market impact. For derivatives, also include funding, liquidation and leverage constraints; derivatives remain disabled in this product's first release.
4. Use walk-forward validation with sequential, non-overlapping test folds and a final untouched holdout.
5. Run sensitivity tests across fee/slippage multipliers, timeframes, assets and nearby parameter values.
6. Run bootstrap confidence intervals and permutation/null tests where appropriate; correct for multiple strategy variants.
7. Report all folds, not only the best one. Include profit factor, expectancy, max drawdown, turnover, exposure, tail loss, Sharpe-like statistics and benchmark-relative performance.
8. Run a forward paper trial with live data after research validation. Reconcile every simulated fill and fee.

## v0.2 implementation delivered

- More conservative OHLCV validation and deduplication.
- Expanded deterministic analysis: EMA trend alignment, RSI, ATR%, approximate realized volatility, relative volume, 20-bar breakout, explicit market regime and higher-timeframe confirmation.
- Solana screening is stricter on top-holder concentration and missing authority evidence.
- Backtest decisions are evaluated at the previous close and filled at the next candle open, with entry/exit fee and slippage assumptions.
- Added profit factor, per-trade expectancy, turnover and drawdown reporting.
- Added a sequential walk-forward research endpoint: `POST /api/research/walk-forward`, including 1.0x/1.5x/2.0x fee-and-slippage stress scenarios.
- Dashboard analysis displays regime, ATR, relative volume, breakout, backtest and walk-forward summary.

## Known limitations / next research backlog

- Walk-forward baseline is a fixed EMA cross, not an optimized or ML model; the current number of folds and data window are small for production claims.
- Candle-based simulation cannot reproduce order-book queue position, intrabar path, partial fills, market impact or actual latency.
- CEX market data and Jupiter discovery calls have not been verified against live external endpoints in this build environment.
- The current paper broker is manually entered; there is no fully automated signal-to-paper-entry scheduler yet.
- Solana paper exits require a dedicated live mark feed; discovery prices must not be used as a substitute.
- Daily/weekly paper loss limits currently use realized P&L; production-grade risk must include mark-to-market unrealized P&L and portfolio heat.
- Solana token screening is not a complete contract audit and does not guarantee tradability or safety.
- No trained ML model, probability calibration, correlation-aware portfolio optimizer, order-book simulator or live execution adapter is included.

## Release gates

### Research gate
- At least three sequential test windows plus a final untouched holdout.
- Positive net expectancy after conservative costs across more than one asset/regime, not merely one best fold.
- No catastrophic tail loss; maximum drawdown below a user-approved threshold.
- Performance remains viable when fee/slippage assumptions are stressed (e.g. 1.5x and 2x).
- No unexplained look-ahead, leakage, duplicate candle or accounting defect.

### Paper gate
- At least 30 calendar days of forward paper operation and a meaningful sample (target 200 trades where opportunities permit).
- No balance/ledger mismatch, duplicate order, stale-price execution or risk-limit bypass.
- Compare simulated fills against observable bid/ask and quote snapshots; report simulation bias.
- Kill switch and persistent halt tested under provider outages and process restarts.

### Live gate (separate project/release)
- Provider and jurisdiction eligibility confirmed for the user.
- Security review of key storage, signing policy, permissions, network access and dashboard authentication.
- Exchange sandbox/testnet or Solana devnet integration tests, then tiny capped pilot only after explicit user approval.
- Withdrawal permissions disabled; no main wallet seed phrase ever collected.
- Actual fills/fees/chain balances reconciled; ambiguous submissions queried before retry.
- Independent kill switch, spend caps and daily/weekly mark-to-market loss stops.

## Success definition

Success means a repeatable, auditable system that knows when not to trade, demonstrates positive risk-adjusted net performance on untouched and forward data, stays within drawdown limits, and reconciles every simulated/live fill. It does not mean a guaranteed profit or a green dashboard.


## v0.3.8 implementation baseline (historical; 2026-11-07)

- Indicator baseline is SMA-seeded EMA20/50 with Wilder RSI14/ATR14/ADX14, +DI/-DI, EMA20 slope, closed-bar relative volume, a 20-bar breakout test and volatility regime. The score is explicitly a rule score, not a calibrated probability.
- Raw OHLCV integrity is audited before use: malformed rows, duplicate timestamps, UTC epoch misalignment for minute/hour/day bars, missing intervals and non-integral spacing. Both market analysis and strategy backtests fail closed; candle gaps force `HOLD`.
- Strategy-aligned historical replay/walk-forward uses closed 1h/4h bars, prior-close decisions and next-primary-open entries, the same main indicator and higher-timeframe confirmation, current saved server risk/cost settings, cost-inclusive position sizing, the four-bar cooldown and three-entry UTC-day limit.
- It compares against a buy-and-hold allocation at the configured maximum exposure and reports 1.0x/1.5x/2.0x fee/slippage stress. The comparator is not a fully risk-matched portfolio model, and no historical candle model can reconstruct live market-quality or order execution fields.
- New paper entries require at least 1:1 estimated net reward/risk after round-trip fees/slippage. Invalid persisted risk settings stop new entries; emergency paper exits remain available with conservative bounded exit costs.

## Remaining research requirements

The implementation is not an ML model and has no calibrated trade probabilities. It does not yet model correlation-aware portfolio allocation, cross-exchange price divergence, complete order-book replay, partial fills, venue fees/rebates tiers, funding, latency or actual historical spreads/depth. The current fetched history is not a final untouched holdout. A meaningful forward paper trial, untouched data evaluation across assets/regimes, robustness to additional costs, and audit of every signal/fill are still required. Never adjust parameters against the displayed walk-forward output and then call the same windows independent validation.


## v0.3.9 risk/execution alignment (2026-11-07)

Automatic paper sizing now includes the observed spread as a conservative additional round-trip cost buffer. Portfolio sizing and trade insertion are serialized within the single-worker local app. Take-profit fills are capped at their trigger target before sell-side slippage, preventing optimistic price improvement. This remains a paper execution approximation; it still cannot model queue position, partial fills, venue latency, market impact or historical spread.


A v0.3.9 replay audit also fixed entry-candle protective-exit handling: after a signal at the prior close and fill at the next open, that same candle's high/low is checked for stop/target. Simultaneous touches are valued stop-first. This removes an optimistic omission in the prior simulator but does not eliminate candle-path ambiguity or turn OHLC replay into real execution evidence.


## v0.3.9 replay/execution audit update (2026-11-07)

- Entry-bar stop and target checks are included after next-open fills. Simultaneous OHLC touches resolve stop-first; this is intentionally conservative because candle data does not reveal intrabar sequencing.
- Automatic paper entry risk budgets include observed spread in addition to fees/slippage. Take-profit fills use the configured target reference rather than optimistic mark-price improvement.
- Portfolio sizing/open insertion is serialized for the single-worker local runtime; this is not a distributed lock.
- A 120-test checkpoint includes regression coverage for entry-bar exits, scan/exit-monitor behavior and Testnet emergency stop beyond the recent-history page.

The research remains candle-based and does not reproduce historical spread/depth, queue position, partial fills, latency, market impact or cross-asset correlation. A real forward paper sample and authenticated sandbox reconciliation remain outstanding.
