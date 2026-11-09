# Master Automation Execution Plan — v0.7.1

## Current delivered architecture

The project has two distinct PAPER surfaces:

1. **Android Local PAPER:** the Android APK can use public market data and a local virtual ledger. Manual entry and close require valid fresh quotes; stale cached prices fail closed.
2. **Cloudflare Free PAPER Worker:** optional cloud dashboard and SQLite-backed Durable Object ledger. It reads Coinbase public data for BTC/USD, ETH/USD and SOL/USD, checks 1-hour and 6-hour candles, and schedules paper monitoring approximately every 15 minutes once initialized.

The Android app is a client, not an exchange execution engine. The Cloudflare Worker is also PAPER-only. Its health endpoint explicitly declares live trading and Binance Testnet disabled.

The older Python/FastAPI backend, Render Blueprint and Binance Testnet documentation are separate code/deployment paths. They must not be confused with the current Cloudflare Free PAPER Worker.

## Verified release state

- Android version: 0.7.1, versionCode 48.
- Package: `app.aitradingterminal.debug`, min SDK 26, target SDK 35.
- GitHub Release: https://github.com/fayisaftha786/ai-trading-terminal-/releases/tag/v0.7.1-debug
- Android v0.7.1 APK release commit: `369aaac4d3d5191e8a0648a675c3dc5327301bbb` (the APK release is older than current source).
- Base GitHub `main` at the start of this Phase 1 update: `b9e67f2eb2ef00f69a19ec4667c562f7a7ea7a23`.
- Main-branch CI built and verified the installable debug APK and published it to GitHub Releases.
- The code has passed backend/release checks, Worker validation/local smoke tests and Android build/signature/metadata checks.
- Physical device installation and live Cloudflare deployment remain unverified.

## Cloudflare deployment — owner-controlled steps

A live health check at 2026-11-09 04:46:35 UTC reported scheduler `healthy`, the last scheduled scan `completed`, last-alarm age 67.9 seconds and next alarm at 05:00:31 UTC. The Worker version timestamp was 04:29:42 UTC, but `worker_version.tag` remains blank, so the exact deployed GitHub revision is not yet proven. The owner must:

1. Sign in to or create a Cloudflare account and choose the Free plan only.
2. Read and accept Cloudflare's current Terms of Service and Privacy Policy directly with Cloudflare.
3. In Workers & Pages, connect the GitHub repository `fayisaftha786/ai-trading-terminal-`, production branch `main`, and configure the root Worker build using the exact instructions in [CLOUDFLARE_FREE_PAPER_AUTOMATION.md](CLOUDFLARE_FREE_PAPER_AUTOMATION.md).
4. Configure `ADMIN_PASSWORD` (at least 16 characters) and `SESSION_SECRET` (at least 32 characters) using Cloudflare's secret manager. Never paste secrets into chat, issue comments or source files.
5. Deploy and verify the HTTPS Worker health response: `status=ok`, `mode=paper_only`, `live_trading_enabled=false`, `binance_testnet_enabled=false`, and `worker_version.tag` equal to current `main` SHA.
6. Sign in and validate fresh market data, 1h/6h closed-candle integrity, local Coinbase order-book response-retrieval age (15-second maximum for automatic entries; not an exchange event timestamp), persistence after refresh/restart, and recurring alarm cadence.
7. Keep automatic PAPER entries OFF until these checks pass. Enabling them is a separate, explicit owner action and authorizes virtual trades only.

A temporary 60-minute preview is optional and requires the owner to accept Cloudflare's Terms and Privacy Policy and complete Cloudflare's claim flow. It is a temporary verification bridge, not a permanent deployment. See the Cloudflare documentation linked above.

## Risk and runtime boundaries

- Initial Cloudflare paper equity is USD 100 of virtual funds.
- Entry risk budget: 0.25% of virtual equity; maximum total exposure: 20%; maximum 3 open positions; maximum 3 entries per UTC day; 4-hour per-symbol cooldown.
- Initial stop/target assumptions: 1% stop and 3% target. Estimated fee: 15 bps per side; estimated slippage: 10 bps.
- Daily loss stop: 1.5%; weekly loss stop: 4%; peak-to-trough stop: 5%.
- These values are research assumptions for simulated execution. They are not guaranteed execution levels or recommendations for live capital.
- Alarm cadence is approximate and subject to platform limits, quota, network failures and delays. A simulated stop is not an exchange-native protective order.
- Cloudflare Free has request, CPU, storage and SQL quotas. It is not unlimited continuous compute. Do not upgrade to a paid plan under a ₹0 budget; halt rather than bypass a quota or safety failure.

## Phase 1 research-integrity hardening

The research tournament must reject malformed OHLCV rows, null/empty numeric fields, duplicate timestamps, off-grid timestamps and gaps instead of silently dropping bad rows and continuing on a partial sample. Final forced-liquidation fees and slippage must be included in the final equity-curve drawdown mark. These are research correctness controls; they do not enable trading or approve a strategy.

## Phase 1 authentication hardening

Failed-login throttling now uses the TradingEngine Durable Object SQLite ledger instead of Worker-isolate memory. The ledger stores a keyed HMAC-SHA-256 source-IP fingerprint, allows at most eight attempts in a rolling ten-minute window, clears the source counter after successful authentication, and fails closed if the limiter is unavailable. Regression coverage must verify the threshold, source isolation and successful-login reset in the local Cloudflare runtime smoke test.

## Phase 2 market-data source integrity

The GitHub read-only scanner must not combine a ticker from one exchange/quote currency with OHLCV candles from another. Every result reports the configured exchange separately from the actual market-data adapter, plus the ticker provider, strategy-candle provider, and both quote currencies. A signal is forced to HOLD unless provider and quote currency match exactly and the market is fresh with contiguous closed candles. Coinbase fallback is allowed for read-only diagnostics, but it cannot supply a signal for a Binance market unless the ticker side also comes from the same Coinbase USD source.

## Phase 3 regime-aware strategy research

The research-only strategy lab compares three spot-long hypotheses without changing the production PAPER entry engine:

1. Trend pullback and EMA20 reclaim, requiring a higher-timeframe uptrend and positive directional strength.
2. Volatility breakout, requiring a close above the prior 20-bar high, at least 1.5x relative volume, ADX/positive directional movement and bounded ATR.
3. Range mean reversion, requiring a range regime on both timeframes, low ADX, RSI at/below 40 and a confirmed reclaim into the lower Bollinger band.

The lab uses only closed candles and rejects gaps, duplicate/off-grid/malformed data, insufficient history and higher-timeframe candles that close after the primary timeframe. Its heuristic scores are not probabilities and are never execution authorization. Before any strategy can be promoted, require chronological out-of-sample results, walk-forward folds, look-ahead/recursive-indicator checks, realistic spread/fee/slippage stress, regime and asset segmentation, and forward PAPER evidence. Keep the existing conservative strategy as the only entry path until a separate promotion review passes.

## Next verification after deployment

- Confirm the Worker remains healthy and authentication rejects bad passwords/tokens.
- Confirm all three Coinbase markets are live and the ticker and local order-book retrieval ages meet freshness gates.
- Confirm candle audits show sufficient closed history and zero gaps/duplicates/off-grid rows.
- Confirm SQLite Durable Object ledger, events and halt state persist after refresh and deployment restart.
- Confirm scheduled alarms resume and produce fresh scans at approximately 15-minute intervals.
- Confirm kill switch disables new entries and that it does not falsely report that open simulated positions have been closed.
- Only after all checks pass may the owner explicitly enable PAPER auto-entry.
- Collect at least 30 calendar days of forward paper observations and a meaningful trade sample before evaluating strategy changes. A clean CI run or backtest is not proof of future profit.

## Absolute guardrails

- Do not request or store wallet seeds, exchange withdrawal keys or user passwords in source files, APKs or chat.
- Do not claim 100% profit. The strategy score is deterministic and uncalibrated, not a probability.
- Do not enable real-money order execution or wallet signing. Those are not delivered in the Cloudflare Worker.
- Do not call a local smoke test a live-cloud test or claim physical Android installation unless it is actually performed.
