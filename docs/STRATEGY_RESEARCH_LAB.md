# Strategy Research Lab

## Why this exists

The existing automatic PAPER entry path is a conservative 1h trend-continuation strategy with higher-timeframe confirmation. This lab adds independent research hypotheses so the project can compare different market regimes without silently changing the production entry rules.

## Lessons from established open-source systems

| System | Design lesson adopted | What we do not copy |
|---|---|---|
| Freqtrade | Explicit dry-run, protection rules, look-ahead and recursive-indicator audits, chronological optimization | Example strategies or optimized parameters as if they were profitable |
| Hummingbot | Separate strategy logic, execution components and exchange connectors | Market-making/arbitrage execution in this spot-long paper engine |
| QuantConnect LEAN | Separate universe selection, research, portfolio accounting and scheduled operations | A full brokerage/plugin engine that is too heavy for the current free deployment |
| Jesse | Candle-by-candle backtests, trade-level metrics and benchmark comparisons | Treating a backtest result as a promise of future returns |
| NautilusTrader | Use explicit fill models, spread, slippage, order-book and execution assumptions | Adding a Rust/event-bus runtime before the current system needs it |

Official references:
- Freqtrade: https://www.freqtrade.io/en/stable/
- Freqtrade look-ahead analysis: https://www.freqtrade.io/en/stable/lookahead-analysis/
- Freqtrade protections: https://www.freqtrade.io/en/stable/plugins/
- Hummingbot: https://hummingbot.org/docs/
- LEAN: https://www.quantconnect.com/docs/v2/lean-engine/getting-started
- Jesse backtesting: https://docs.jesse.trade/docs/backtest/
- NautilusTrader backtesting: https://nautilustrader.io/docs/latest/concepts/backtesting/

## Runtime placement

- The Python/FastAPI market-analysis endpoint exposes the lab using the exact higher-timeframe interval returned by the selected provider (4h or 6h).
- The Cloudflare Free Worker uses its own Coinbase 1h/6h market snapshots and displays the same three hypothesis families in the Market Intelligence dashboard.
- Neither display or scoring path feeds `AutoPaperEngine`, `openPaperTrade` or a live order endpoint. Candidate output is diagnostics only.

## Strategy families in this first research version

### 1. Trend pullback and EMA reclaim
A directional higher-timeframe uptrend must be present. The primary timeframe must reclaim EMA20 after a pullback, remain above EMA50, show positive directional movement, keep RSI below an extension threshold and avoid extreme ATR.

### 2. Volatility breakout
The latest closed bar must close above the prior 20-bar high (the current candle is excluded from its own breakout threshold). Relative volume must be at least 1.5x its previous 20-bar baseline, ADX and positive directional movement must confirm the move, a higher-timeframe uptrend must be present, and ATR must remain bounded.

### 3. Range mean reversion
Both timeframes must classify as range/transition, primary ADX must be low, RSI must be at or below 40, and price must close back inside the lower Bollinger band after being below it. This avoids buying while price is still falling outside the band.

## Data and safety gates

- Only fully closed candles are analyzed.
- Both histories need at least 150 clean bars.
- Malformed rows, duplicate timestamps, off-grid candles, missing intervals and future higher-timeframe closes block the research result.
- Heuristic scores are transparent rule counts, not calibrated probabilities or model confidence.
- Every returned candidate carries `execution_authorized=false`.
- The lab is not connected to `AutoPaperEngine`, any exchange order route, wallet or signing key.
- A candidate does not become a trading strategy merely because the heuristic filters are satisfied.

## Promotion gate before any strategy can reach automatic PAPER

1. Chronological train/validation/test separation. Do not tune on the final test window.
2. Walk-forward folds across multiple market regimes and assets.
3. Look-ahead and recursive-indicator stability checks.
4. Realistic spread, fees, slippage, order-book depth, latency and adverse fill assumptions.
5. Benchmark comparison, drawdown, profit factor, expectancy, exposure, trade count and cost stress.
6. At least 30 calendar days of forward PAPER evidence and a sufficient trade sample.
7. Manual review of risk limits and rollback behavior.

Until every gate passes in a separate reviewed change, the original conservative strategy remains the only automatic PAPER entry strategy. Live execution remains disabled.
