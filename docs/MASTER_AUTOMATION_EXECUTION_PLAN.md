# Master Automation Execution Plan — v0.7.2

## Current delivered architecture

The project has two distinct PAPER surfaces:

1. **Android Local PAPER:** Android app, public market data and a local virtual ledger. Manual entry and close require fresh quotes; stale cached prices fail closed.
2. **Cloudflare Free PAPER Worker:** dashboard, SQLite-backed Durable Object ledger, market scan and simulated exit monitor on an approximately 15-minute alarm.

The Cloudflare Worker is PAPER-only. Live exchange orders and Binance Testnet execution remain disabled. The older Python/FastAPI backend and Render Blueprint are separate code/deployment paths and are not the Cloudflare Worker.

### Market-data providers

- Current production Worker: Coinbase USD spot REST for BTC/USD, ETH/USD and SOL/USD.
- PR #62 adds Bitstamp as a secondary USD spot source for the same three markets. It fetches ticker, grouped order book, native 1H candles and native 6H candles from Bitstamp as one complete snapshot.
- A market snapshot must use one provider for ticker, book, 1H and 6H. The system never blends Coinbase quotes with Bitstamp candles. Provider provenance is checked by the global market-universe gate.
- If both providers fail, or the secondary source is incomplete, new entries stay blocked. A fresh primary bid can still be retained for PAPER exit marking; it is not permission to open a new trade.

## Verified release state

- Android version 0.7.1, versionCode 48; package `app.aitradingterminal.debug`, min SDK 26, target SDK 35.
- GitHub Release: https://github.com/fayisaftha786/ai-trading-terminal-/releases/tag/v0.7.1-debug
- Android v0.7.1 APK release commit: `369aaac4d3d5191e8a0648a675c3dc5327301bbb`; this APK release is older than current source.
- Current GitHub main at the time of this update: `118c4a3d0a0d074a5bc2d85368e0caf2df7875db`.
- PR #62 source HEAD: `3f0d9f68e23627f95d59268e3f6ec4d32f645cc9`; syntax checks, unit tests, Wrangler dry-run and local Durable Object/authentication/kill-switch smoke test all passed. The PR adds secondary provider failover and diagnostic/dashboard updates; merge and production verification are separate steps.
- Physical installation of the debug APK on the owner's Android device has not been verified.

## Cloudflare deployment and live health

The Workers Builds/Git integration is already connected to the repository and has deployed prior revisions. The latest inspected production health sample reported:

- Worker API: `status=ok`, mode `paper_only`.
- Version ID: `d8bf47a9-2c7b-4df6-9f79-a0d690255c79`, timestamp `2026-11-09T06:17:28.191488Z`.
- `worker_version.tag` is blank, so the exact deployed Git commit cannot be verified yet.
- Scheduler / last scheduled scan: `partial`; BTC and ETH healthy, SOL unhealthy; 2 of 3 configured markets healthy.
- The reported SOL issue included provider unavailability, ticker timestamp/quote validation and missing/stale order-book/depth checks.
- `live_trading_enabled=false` and `binance_testnet_enabled=false`.

Do not enable automatic PAPER entries while any market is unhealthy. PR #62's Bitstamp failover has not been proven in production until it is merged, deployed and observed in a new health response.

### Remaining owner-controlled Cloudflare setting

For verifiable commit tagging, sign in to Cloudflare and open the existing Worker:

**Workers & Pages → ai-trading-terminal → Settings → Build → Deploy command**

Set the deploy command to:

```sh
npx wrangler deploy --tag "$WORKERS_CI_COMMIT_SHA" --message "Git commit $WORKERS_CI_COMMIT_SHA"
```

Workers Builds injects `WORKERS_CI_COMMIT_SHA` into the build process. The deployed Worker's version metadata should then report a tag equal to the Git commit SHA. Do not place Cloudflare tokens or passwords in Git, chat or source code.

The separate manual GitHub Actions deployment workflow requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets. Those are not necessary for the existing Workers Builds integration, which already performs deployments.

Keep `ADMIN_PASSWORD` and `SESSION_SECRET` configured as Cloudflare runtime secrets. The owner must set or rotate them directly in the Cloudflare dashboard; never paste secret values into chat.

## Risk and runtime boundaries

- Initial virtual PAPER equity: USD 100.
- Baseline trade risk: 0.25% of equity; gross total-exposure cap: 20%; maximum 3 open positions; maximum 3 entries per UTC day; 4-hour per-symbol cooldown.
- Baseline simulated stop/target assumptions: 1% stop and 3% target. Estimated fee: 15 bps per side; estimated slippage: 10 bps.
- Daily loss limit: 1.5%; weekly loss limit: 4%; peak-to-trough drawdown limit: 5%.
- Added adaptive controls reduce sizing with drawdown, pause new entries after consecutive realized losses, apply soft loss locks and raise cost-aware PAPER trailing stops. These are guardrails, not guarantees.
- The 15-minute monitor is not an exchange-native stop. Gaps, stale providers, missed alarms and service outages can worsen simulated exits.
- Cloudflare Free has request, CPU, storage and SQL quotas. Do not bypass safety gates or upgrade to a paid plan under the ₹0 budget; stop new entries if limits or data-quality checks fail.

## Strategy research and promotion rules

The current production entry engine remains conservative trend-continuation with higher-timeframe confirmation. The research lab compares three spot-long ideas without authorizing execution:

1. Trend pullback and EMA20 reclaim in a confirmed higher-timeframe uptrend.
2. Volatility breakout above the prior 20-bar high with relative-volume and directional-strength confirmation.
3. Range mean reversion with low ADX and confirmed Bollinger-band reclaim.

Research rejects malformed, duplicate, off-grid, gapped, insufficient or future-confirmation candle data. Scores are heuristic rule counts, not calibrated probabilities. Before any research strategy is promoted, require chronological out-of-sample and walk-forward tests, look-ahead/recursive-indicator checks, spread/fee/slippage stress, regime and asset segmentation, and forward PAPER evidence. Do not copy Martingale, unlimited DCA, unprotected grids or high leverage into the production engine.

## Next verification after PR #62 merge/deploy

1. Confirm Cloudflare deploy completes and `worker_version.tag` equals the new main SHA.
2. Run a read-only scan and confirm BTC, ETH and SOL each report a selected provider and explicit failover state.
3. Confirm 3/3 markets healthy for several consecutive scheduled scans; one complete scan is not enough to enable automatic entries.
4. Confirm selected-provider ticker timestamps, book retrieval age (maximum 15 seconds), both-side top-10 depth (minimum USD 5,000), and at least 150 clean closed candles on 1H and 6H.
5. Confirm public health diagnostics identify provider failures and the primary/secondary error codes instead of returning empty arrays when stored scan summaries contain issues.
6. Confirm SQLite ledger, trade records, events and halt state persist across refresh and deployment.
7. Confirm alarms recur approximately every 15 minutes, the kill switch blocks new entries, and simulated exits continue to be monitored.
8. Keep automatic PAPER entries OFF until these checks pass. Enabling them remains a separate owner action and authorizes virtual trades only.
9. Collect at least 30 calendar days of forward PAPER observations and a meaningful trade sample before evaluating strategy changes.

## Absolute guardrails

- No real-money orders, exchange withdrawal permissions, wallet signing or Binance Testnet execution in this Cloudflare Worker.
- Never request or store passwords, API tokens, wallet seeds or recovery codes in source files, APKs or chat.
- Do not claim 100% profit. A passing CI run, backtest or PAPER result does not prove future profitability.
- Never call a local smoke test a live-cloud test or claim physical Android installation unless it is actually performed.
