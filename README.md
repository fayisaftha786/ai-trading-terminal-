# AI Trading Terminal v0.7.1 — No-Termux PAPER Edition

AI Trading Terminal is an Android-friendly crypto market research and paper-trading project. The current Android package is a **debug/test APK**, not a production-signed release. The Cloudflare Worker is **PAPER-only**: live trading and Binance Testnet execution are disabled. The Binance market scanner is public-data research only; the Binance account connector is read-only and cannot place orders.

**Production audit (2026-11-10, approximately 05:59 UTC):** A fresh cache-busting health request returned `status: ok`, `mode: paper_only`, `schedule_seconds: 90`, `live_trading_enabled=false`, `binance_testnet_enabled=false`, and a healthy scheduler. Its last completed scheduled scan had all 3/3 markets healthy and no scan errors. The current persisted books were older than the strict 15-second entry-quality limit, so the current-feed status correctly failed closed as `snapshot_expired_after_healthy_scan`; this is different from a failed scheduled scan. Do not loosen that entry gate.

**Deployment provenance still needs reconciliation:** GitHub Actions successfully validated and deployed main SHA `da73f33611663a6b1e45ede253d6eea01bbf7be5` at 05:53 UTC and verified the same SHA plus PAPER-only flags immediately after deployment. A later fresh production health probe reported a different Worker version with an empty tag and `deployment_commit_sha: null`. The currently running Worker is therefore not proven to match the GitHub main SHA. Keep PAPER auto-entry OFF until the deployed tag/commit matches the current `main` SHA. Avoid simultaneous Cloudflare Git Builds and GitHub Actions deployments unless both are configured to embed the same commit SHA.


## Current release

- Android version: **0.7.1** (versionCode 48)
- Package: `app.aitradingterminal.debug`
- Minimum Android SDK: 26; target SDK: 35
- Release: [v0.7.1-debug on GitHub Releases](https://github.com/fayisaftha786/ai-trading-terminal-/releases/tag/v0.7.1-debug)
- Direct APK: [AITradingTerminal-Android-v0.7.1-debug.apk](https://github.com/fayisaftha786/ai-trading-terminal-/releases/download/v0.7.1-debug/AITradingTerminal-Android-v0.7.1-debug.apk)

This package is signed with an Android debug key for testing, not a production release key. It has passed the GitHub build and APK verification workflow, but it has **not** been physically installed and tested on the owner's phone in this release process.

## Operating modes

### Android Local PAPER mode

- Uses public market data; no exchange API key is required for read-only market data.
- Virtual positions are local simulations, not exchange orders.
- Manual PAPER entry and close require fresh, valid quotes. Entry uses ask; close uses bid. Stale or missing quote data fails closed instead of using an old cached price.
- Local PAPER history is stored on the device. Uninstalling the app can erase that local history.

### Optional Cloudflare Free PAPER mode

- Cloudflare Worker + SQLite-backed Durable Object ledger.
- Coinbase is the primary USD spot feed; Bitstamp is a secondary same-venue fallback for BTC/USD, ETH/USD and SOL/USD. Ticker, order book, 1H and 6H candles are never mixed across exchanges within one market snapshot.
- Main contains a 90-second delay between PAPER scan/exit-monitor cycles while retaining a 120-second quote-age gate. A post-merge cache-busting health probe reports `schedule_seconds: 90`, but its first next alarm was inherited from the old 15-minute cadence; verify the alarm fires and subsequent alarms remain about 90 seconds apart before enabling PAPER auto-entry.
- The existing production ledger was last documented with USD 100 virtual equity. The merged profile v2 targets USD 10 for a new/empty ledger, with USD 2 reserve and up to USD 8 per position. A legacy ledger with trades and a different starting balance is locked for explicit review; review preserves the old balance and all trade history instead of silently rebasing.
- Automatic PAPER entries start **OFF** in new installs and after migration to profile v2. A legacy ledger with a different starting balance and trade history requires explicit review after all open positions are closed; review preserves its historical balance and trades and keeps auto-entry OFF. The owner must sign in and explicitly enable auto-entry only after validating the deployed main SHA, market freshness, local order-book retrieval age, candle integrity, persistence and alarm cadence.
- Paper automation remains separate from the optional REAL connection. The code supports only guarded, owner-confirmed Coinbase Advanced SPOT LIMIT GTC post-only BUY/SELL orders; the feature remains locked unless Coinbase CDP credentials, an account-verified product allowlist, a quote cap, open/daily order limits and `COINBASE_ADVANCED_ORDER_ENABLED=true` are deliberately configured as Worker secrets. Each order requires a fresh authenticated preflight, exchange-side product/balance checks, a fail-closed scan of active SPOT orders and all SPOT orders created during the current UTC day in the CDP key's permissioned Advanced Trade portfolio, a server-bound preview that expires after 60 seconds, and a separate owner confirmation. These exchange-side checks complement the app's local order ledger; they do not inspect separate Coinbase portfolios or Simple-trade order books. Automatic live entries, withdrawals and transfers are not enabled. Do not enable the execution secret until the account, permissions, product IDs, fee preview and order safeguards have been verified. Binance Testnet execution is hard-disabled. The Worker does not sign wallets or submit Solana swaps.

- Binance read-only account preflight can retrieve account-specific Spot maker/taker commissions for `BTCUSDT`, `ETHUSDT`, and `SOLUSDT` (or up to 10 comma-separated pairs through `BINANCE_READONLY_FEE_SYMBOLS`). It reports standard, tax and special commissions separately and shows the BNB discount only as a potential scenario; the conservative fee includes all commission components and never assumes BNB is available at every fill. The on-demand 50-market AI Brain scan requests exact account commissions for its scanned symbols and uses verified conservative taker rates per pair; missing rates remain on the configured paper-fee fallback and are labeled as such. BNB discounts are not used in strategy edge calculations. This adapter still cannot place/cancel Binance orders. Do not treat public-market data or a fee lookup as permission to execute trades.
- For India-based Coinbase accounts, do not assume USD markets are available or use the example USD product IDs as a guarantee. Coinbase lists Advanced Trade as available in India and announced local INR order books and Advanced APIs, but the exact order books available can vary by account and rollout. Configure only the exact products returned as eligible by the authenticated account preflight. The market scanner's existing USD research signals are not automatically valid signals for an INR product.

See [Cloudflare Free Paper Automation](docs/CLOUDFLARE_FREE_PAPER_AUTOMATION.md) for the deployment and health-verification procedure.

## Market scan evidence

GitHub Actions also runs a separate read-only market scanner using public Binance data. Its report does not create paper positions and does not send orders. The latest archived scan (2026-11-09 04:26:14 UTC, main `b9e67f2eb2ef00f69a19ec4667c562f7a7ea7a23`) returned fresh live data for BTC/USDT ($74,935.52; HOLD, score 40), ETH/USDT ($2,142.81; HOLD, score 30) and SOL/USDT ($87.50; HOLD, score 40). All three were in aligned 1H/6H downtrends and each had 349 clean closed candles on both timeframes, with no gaps, duplicates, malformed rows or off-grid timestamps. The scanner allows at most 5 seconds of future timestamp skew for exchange/runner clock differences; the raw age remains visible in the report, and timestamps beyond that tolerance fail closed. See the [market scanner workflow](.github/workflows/free-cloud-market-scanner.yml).

A HOLD result is intentional when the configured strategy filters do not align. The strategy score is deterministic and uncalibrated; it is not a probability or a forecast.

The read-only scanner now reports the configured exchange separately from the actual market-data adapter (including Coinbase fallback), and reports ticker and candle-analysis providers plus their quote currencies per market. It downgrades signals to HOLD unless both feeds match exactly, preventing a Binance USDT ticker from being paired with Coinbase USD candles during fallback.

## Strategy research lab

The research lab is shown in both the Python/FastAPI market-analysis panel and the Cloudflare Worker Market Intelligence table. The Cloudflare Worker currently evaluates its own Coinbase 1H/6H paper-market snapshots; the Python service uses the actual provider interval returned by its market-data adapter. Both implementations are research-only and remain disconnected from automatic entry.

The read-only market scanner now compares three separate spot-long research hypotheses alongside the existing trend signal:

- `trend_pullback`: higher-timeframe uptrend, EMA20 reclaim after a pullback, positive directional strength, controlled RSI and ATR.
- `volatility_breakout`: close above the prior 20-bar high, at least 1.5x relative volume, ADX/positive directional movement and controlled ATR.
- `range_mean_reversion`: range regime on both timeframes, low ADX, RSI at or below 40, and a confirmed reclaim of the lower Bollinger band (not a falling-knife entry).

The lab rejects malformed, gapped, duplicate, off-grid, insufficient or future higher-timeframe candles. PR #66 strengthens offline research with four chronological non-overlapping test folds of at least 28 days, an untouched final holdout, out-of-sample trade counts, 2x fee/slippage stress and deterministic Monte Carlo trade-order / moving-block resampling. The stricter walk-forward gate requires at least 3,000 clean 1H and 500 clean 6H bars (roughly 125 days of 6H history); it reports insufficient history until that sample exists. Monte Carlo resampling is a sensitivity diagnostic, not a prediction. Strategy scores are transparent rule counts, not probabilities or model confidence. None of this research connects directly to automatic PAPER entries.

## Security and limitations

- No profit or positive return is guaranteed. A working bot can still lose money in simulation and live markets.
- The Cloudflare Worker is PAPER-only. The dashboard must remain in PAPER mode.
- The Worker uses public endpoints and does not need exchange credentials. Failed-login throttling is stored in the Durable Object SQLite ledger under a keyed HMAC-SHA-256 source-IP fingerprint; raw IP addresses are not stored by this limiter. Eight attempts are allowed per source in a rolling ten-minute window, and a successful login clears that source's counter. If the limiter is unavailable, login fails closed. Never place passwords, session secrets, exchange API keys, wallet seeds, recovery codes or Cloudflare tokens in source control or chat.
- Cloudflare account creation, acceptance of Cloudflare legal terms, secrets configuration and live deployment remain owner-controlled.
- Cloudflare Free has documented request, CPU, storage and SQL quotas. It is not an unlimited 24/7 compute guarantee. Stop automation if quota or data-quality gates fail; do not upgrade to a paid plan under a ₹0 budget.
- The production 15-minute / proposed 90-second simulated exit monitor is not an exchange-native stop-loss. Fast price gaps, service outages or missed alarms can produce a much worse simulated exit than the trigger level.
- Paper fills approximate spread, fee and slippage assumptions. They do not reproduce queue position, partial fills, latency, market impact or actual account fee tiers.
- A good backtest, passed CI run, paper result or Testnet fill does not prove future profitability.
- The Android APK is a debug/testing build, not production-signed. If an update is rejected because the signing key differs from a previously installed debug build, export any local PAPER records before uninstalling; uninstalling may erase local history.

## No-Termux deployment

For the recommended phone-only Cloudflare setup, follow [docs/CLOUDFLARE_FREE_PAPER_AUTOMATION.md](docs/CLOUDFLARE_FREE_PAPER_AUTOMATION.md). The guide uses Cloudflare Dashboard Git integration and owner-configured runtime secrets; it does not require Termux or local Node.js on Android.

The older FastAPI/Render deployment documents describe a separate backend path and may require paid hosting. They are not the Cloudflare Free PAPER deployment described above.

## Development and verification

- JavaScript Worker: `npm run check`, `npm test`, Wrangler dry-run and local workerd smoke test.
- Python backend: `pytest` and the repository release gate.
- Android: Gradle build plus APK signature and metadata checks in GitHub Actions.

These checks validate code and local simulations. They do not prove a live Cloudflare deployment, the owner's Cloudflare quota, regional Coinbase reachability, real scheduled alarm cadence or installation on a physical Android device.
