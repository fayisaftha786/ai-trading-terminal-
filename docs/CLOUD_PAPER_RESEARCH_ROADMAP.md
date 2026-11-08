# Cloud PAPER research roadmap — 2026-11-08

## Scope and safety boundary

This roadmap applies to the Cloudflare Worker implementation in `src/` and `public/`. It is distinct from the older FastAPI/Python research stack under `app/`. The Cloudflare Worker remains PAPER-only: no exchange order adapter, private exchange credentials, wallet signing, or live execution should be introduced as part of this roadmap.

The objective is not to maximize trade count. It is to determine whether a strategy has repeatable net expectancy after realistic costs, and to identify conditions where the correct action is NO TRADE. The existing signal score is a deterministic rule score, not a probability or trained AI prediction.

## Current Cloud Worker baseline

- Universe: BTC/USD, ETH/USD and SOL/USD from Coinbase Exchange public REST.
- Timeframes: validated closed 1-hour and 6-hour candles.
- Features: EMA 20/50 alignment and slope, Wilder RSI(14), ATR/ADX(14), directional movement, relative volume and a 20-bar breakout check.
- Candidate gates: fresh two-sided ticker; spread no wider than 25 bps; at least USD 5,000 top-10 depth on both sides; order-book response retrieved within 15 seconds; estimated 24-hour quote volume at least USD 1 million; fresh closed candles; primary score at least 75; both timeframes in uptrend; volatility/momentum guards; and expected range above a conservative multiple of estimated round-trip costs.
- Risk baseline: 0.25% risk budget per entry, 20% max exposure, 3 max open positions, 3 entries per UTC day, 4-hour per-symbol cooldown, 1% stop, 3% target, estimated 15 bps fee and 10 bps slippage per side assumptions, plus daily/weekly/total drawdown controls.
- Persistence: one current market snapshot per symbol, bounded event and cycle logs, an equity snapshot history capped at 2,000 rows, and the durable trade ledger.
- Scheduler: Durable Object alarm targets approximately 15-minute scans. It is at-least-once/best-effort monitoring, not an exchange-native stop or a guaranteed 24/7 service.

## Immediate improvement delivered in this branch

### Per-market entry-gate diagnostics

Each market snapshot now records the exact first candidate-gate result using the same `assessCandidate` function that the PAPER auto-entry path uses. The dashboard displays the gate outcome and the strategy's signal reason even when auto-entry is OFF. The last scan's portfolio/global entry results are also retained in runtime status.

This is read-only observability. It does not loosen thresholds, create trades, change risk limits, or turn automatic PAPER entries on. A symbol may pass its own gate and still be blocked by the full-market-universe, portfolio, loss-limit, exposure, cooldown or circuit-breaker checks.

## Priority roadmap

### P0 — Explain every decision (this branch)

- Expose per-symbol candidate gate outcomes whether automation is ON or OFF.
- Preserve the last global entry decision and concise rejection details.
- Keep the exact same candidate assessment for diagnostics and actual entry selection to avoid the UI claiming a different rule set from the engine.
- Validate Worker syntax, unit suite, Wrangler dry-run and local Durable Object/auth/kill-switch smoke.

### P1 — Build a durable research dataset

The current Cloud Worker does not persist its raw candle history; the market snapshot table is overwritten per symbol. It therefore cannot independently reconstruct a long historical sample from the cloud ledger.

Add an idempotent OHLCV table keyed by exchange, product, timeframe and candle-open timestamp. Store only validated closed bars, with a schema/version marker and receive time. Upsert duplicates safely, reject revisions that break integrity, and apply retention limits consistent with the Cloudflare Free SQL quota. Keep raw market data separate from trade records so research cannot mutate the PAPER ledger.

### P2 — Strategy tournament, not live strategy replacement

Evaluate three transparent hypotheses in a separate research path:

1. Trend continuation: the current EMA/trend-confirmation baseline.
2. Range mean reversion: only in a range regime; use volatility-scaled entry/exit rules and strict cost gates.
3. Breakout continuation: a closed-bar range breakout requiring relative-volume confirmation and higher-timeframe context.

Use identical time windows, position sizing, fees, spread/slippage stress assumptions and execution rules. Signals from candle close must fill no earlier than the next bar; when stop and target are both touched in one candle, resolve conservatively stop-first. Compare against cash/no-trade and a clearly defined buy-and-hold benchmark.

### P3 — Robust validation and reporting

- Use sequential, non-overlapping walk-forward folds and a final untouched holdout; never randomly shuffle time-series rows.
- Report every fold and every asset, not only the best result.
- Include net expectancy, profit factor, maximum drawdown, turnover, trade count, exposure, average hold, tail loss, and results by volatility/trend regime.
- Stress total trading costs at base, 1.5x and 2.0x. Include a stricter spread/slippage scenario.
- Track parameter trials to reduce selection bias. Do not repeatedly tune against the final holdout.
- Require more than one asset/regime to support a strategy hypothesis; a small positive backtest is not a deployment approval.

### P4 — Forward PAPER evidence

- Run a minimum 30-calendar-day forward observation period, targeting 200 closed trades where opportunities permit.
- Record each candidate, rejection reason, strategy version, market timestamps, quote/book retrieval time, cost assumptions, fill model and eventual outcome.
- Add shadow candidates: track price movement after a rejected/near-qualified signal without opening a position. This helps measure missed opportunities and false positives without increasing PAPER exposure.
- Reconcile every entry, exit, fee and equity change. Keep automatic PAPER entries OFF until data, scheduler, persistence and risk-control checks pass.

### P5 — Cross-asset intelligence, then optional ML research

- Add BTC regime context and ETH/BTC and SOL/BTC relative-strength features only after sufficient clean history exists.
- Estimate rolling cross-asset correlations and avoid assuming BTC, ETH and SOL are independent positions.
- Consider ML only after a transparent baseline wins on untouched data. Train offline; use chronological validation and probability calibration. Until calibration is demonstrated, show a score and reasons, never a probability.
- Any future model may rank or explain research candidates; it must not change loss caps, risk budgets, account permissions, kill-switch state or live execution permissions.

## Release gates

No new strategy becomes the automatic PAPER default unless: all data gates are clean; at least three chronological test folds and an untouched holdout have been evaluated; results remain acceptable under 1.5x and 2x costs; no single asset/regime explains the entire result; and the forward PAPER sample shows no duplicate entries, stale-price fills, ledger drift or risk-limit bypass.

No backtest or PAPER result authorizes real-money trading. Live execution remains a separate project requiring an independent security, provider, jurisdiction and reconciliation review.
