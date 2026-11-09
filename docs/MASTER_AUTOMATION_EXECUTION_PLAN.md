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
- Current GitHub `main` as of 2026-11-09: `0d54d15209828393cd9ee457e98abae9b2c40111`.
- Main-branch CI built and verified the installable debug APK and published it to GitHub Releases.
- The code has passed backend/release checks, Worker validation/local smoke tests and Android build/signature/metadata checks.
- Physical device installation and live Cloudflare deployment remain unverified.

## Cloudflare deployment — owner-controlled steps

The public Worker URL currently responds and its health response reports scheduler `healthy` with the last scheduled scan `completed`. The `worker_version.tag` remains blank, so the exact current GitHub `main` revision is not yet proven deployed. The owner must:

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
