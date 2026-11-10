# Full implementation and release plan

The current repo implements a tested paper-first foundation. The following is the controlled route from this foundation to a verified trading product. A stage is not considered complete because a screen exists; it must pass its evidence gate.

## Phase A — Market data reliability

### Multi-Crypto
- Select one exchange only after confirming account eligibility and API availability for the user's jurisdiction.
- Verify exchange id, symbol precision, market status, quote currency, lot size, minimum notional, fees, and server clock.
- Use public ticker/order-book/OHLCV streams with per-endpoint rate limiting and reconnect/backoff.
- Persist source, exchange timestamp, receive timestamp, and freshness status with every observation.

### Solana
- Use Jupiter Tokens API V2 `/recent`, `/search`, category and tag routes as appropriate.
- Use mint address as the primary key; never trade by ticker/name.
- Persist verification status, Organic Score, liquidity, holder count, `audit.mintAuthorityDisabled`, `audit.freezeAuthorityDisabled`, `audit.topHoldersPercentage`, and `audit.isSus` when present.
- Resolve candidates to pools/routes and obtain a current Jupiter Swap API V2 quote before any simulated trade.
- Add independent RPC checks for mint owner/program, decimals, supply, freeze/mint authority, Token-2022 extensions, pool reserves and account state.
- Reject unknown/ambiguous security data; do not convert absent audit information into a green status.

**Gate A:** source timestamps fresh; rate limits observed; token mint uniqueness enforced; provider failure returns an explicit unavailable state; contract tests cover schema changes.

## Phase B — Strategy research

- Keep the first CEX strategy transparent: EMA20/EMA50 regime filter, RSI14 condition, volume/liquidity guards, volatility filter and deterministic BUY/HOLD/EXIT outcomes.
- Implement Solana setup scoring as a screen, not an autonomous buy oracle. Require liquidity, authority, concentration, organic-activity and quote-impact thresholds.
- Version every strategy and persist every input feature, rule result, score and reason for every signal.
- Do not send trades directly from a language model. If an LLM is later added, it can annotate/explain but cannot alter risk limits or authorize execution.
- Add walk-forward tests, out-of-sample periods, parameter sensitivity, regime segmentation and a benchmark strategy.

**Gate B:** reproducible backtests with realistic fees, spread, slippage, funding/priority costs where applicable; no look-ahead leakage; out-of-sample expectancy positive across more than one market regime; maximum drawdown accepted by the owner.

## Phase C — Paper execution

- Subscribe to live prices and order books; timestamp every quote.
- Simulate market/limit orders, spread, slippage, partial fills, latency, rejection and stale-quote failures.
- Track average fill, fees, realized P&L, unrealized P&L, exposure, equity curve, drawdown, win rate, profit factor and expectancy.
- Reconcile virtual cash, positions and trade ledger after every event.
- Test duplicate submissions, stale data, restarts, SQLite recovery and price gaps.

**Gate C:** at least 30 calendar days and 200 trades where opportunity permits; positive net expectancy after realistic costs; daily/weekly drawdown within agreed limits; no ledger/balance mismatch; all incidents explainable. These are release gates, not a promise of profit.

## Phase D — Risk and control plane

- Calculate limits from mark-to-market equity, not only closed trades.
- Add max notional per asset, correlation/concentration exposure, volatility-adjusted sizing, portfolio heat, cooldowns and daily/weekly hard stops.
- Use a separate process for the risk gate; strategy agents cannot change risk settings.
- Add stale-feed circuit breaker, exchange disconnect stop, RPC health gate, manual kill switch and a persistent halted state.
- Require idempotency keys and query-before-retry for all ambiguous submissions.

**Gate D:** fault-injection tests prove that every critical fault blocks new orders and that the kill switch is effective even if the dashboard disconnects.

## Phase E — Live integration (not part of this build)

### CEX pilot
- Approve one exchange based on local eligibility, provider terms, available spot market, API trading support, withdrawal-disabled keys and IP allowlisting.
- Add a separate adapter with sandbox/test environment, exchange-specific filters, client order IDs, fills/fees streams and balance reconciliation.
- Put signing credentials in a secret manager; never expose them to the browser or AI model.

### Solana pilot
- Use Jupiter Swap API V2. Quote/order data must be parsed and checked against explicit mint, amount, slippage, route, program, fee and destination allowlists.
- Prefer managed execute/landing only after understanding the current route contract. Verify actual signature status and token account deltas; never treat a quote or submitted signature as proof of a fill.
- Use a separate limited hot wallet with minimal capital and a signer behind a strict policy. Never use the user's main wallet seed phrase.
- Recheck recent blockhash lifetime/expiry and transaction status before retrying.

**Gate E:** external security review, jurisdiction/provider eligibility review, sandbox and failure-injection tests, full reconciliation, emergency stop, and a separately approved tiny-capital pilot. Live mode stays disabled until all requirements are satisfied.

## Phase F — Operations

- Run the backend on a reliable always-on host, not an Android browser tab, when unattended operation is required.
- Use PostgreSQL, backups, encrypted secrets, health checks, log retention, alerting and uptime monitoring before multi-day operation.
- Protect remote dashboard access with authentication, TLS, CSRF protection, rate limits and role-based access.
- Keep exchange/provider credentials separate per environment and rotate them on schedule.

## Quantitative upgrade in v0.2

See [QUANT_RESEARCH_PLAN.md](QUANT_RESEARCH_PLAN.md) for the full research framework. The current implementation now validates OHLCV, reports trend/regime/ATR/relative-volume/breakout context, simulates next-candle-open fills with explicit costs, reports expectancy/profit factor, and provides sequential walk-forward evaluation with 1.0x/1.5x/2.0x cost stress and higher-timeframe confirmation. These additions improve research discipline but do not establish profitability.

## Current release status

- Present: local FastAPI dashboard, CEX public data adapter code, Jupiter recent-token data adapter code, conservative token heuristics, EMA/RSI/ATR/relative-volume/breakout baseline, sequential walk-forward research endpoint, next-candle-open cost-aware backtest, paper broker, paper ledger, risk sizing/limits, manual scan and optional background scan, CEX stop/target checks using fresh timestamped ticks, basic EMA backtest endpoint, CI and unit/API tests.
- Not present: validated live network access in this sandbox, automatic trade entries, trained ML, a full token contract audit, complete order-book paper simulation, mark-to-market daily stop, automated Solana paper exits, cloud production operations, exchange order placement, Solana transaction signing.

The current release should be called a **paper-trading research terminal**, not a production autonomous live trading bot.
