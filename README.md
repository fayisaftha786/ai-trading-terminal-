# AI Trading Terminal v0.7.1 — No-Termux PAPER Edition

AI Trading Terminal is an Android-friendly crypto market research and paper-trading project. The current published Android package is a **debug/test APK**. As of 2026-11-09, the Cloudflare Worker URL responds with HTTP 200 and declares **PAPER-only** mode. Its health response exposes scheduler telemetry, but the deployed commit tag is blank, so the exact current GitHub `main` revision is not verified in production.

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
- Public Coinbase market data for BTC/USD, ETH/USD and SOL/USD, with 1-hour and 6-hour candle analysis.
- Scheduled market scan and simulated stop/target monitoring at approximately 15-minute intervals after the Durable Object is first initialized.
- Virtual starting equity is USD 100. Risk limits and estimated execution costs are simulation assumptions, not a promise of returns.
- Automatic PAPER entries start **OFF**. The owner must sign in and explicitly enable them after validating live deployment, market freshness, local order-book retrieval age, candle integrity, persistence and alarm cadence.
- Real-money exchange orders and Binance Testnet execution are hard-disabled in this Worker. It does not sign wallets or submit Solana swaps.

**Deployment status (2026-11-09):** The public Worker endpoint `https://ai-trading-terminal.fayisaftha786.workers.dev/api/health` responds with `status: ok`, `mode: paper_only`, `live_trading_enabled: false` and `binance_testnet_enabled: false`. The returned `worker_version.tag` is blank, so deployment of the audited `main` revision `b9e67f2eb2ef00f69a19ec4667c562f7a7ea7a23` is **not verified**. A live health check at 2026-11-09 04:46:35 UTC reported `scheduler.status=healthy`, `last_scheduled_scan_status=completed`, last-alarm age 67.9 seconds and next alarm at 05:00:31 UTC. The Worker version timestamp was 04:29:42 UTC, but its commit tag remains blank; another alarm observation is needed to establish recurring cadence. The manual GitHub Actions deploy workflow's last attempt failed because `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` were empty. The no-CLI alternative is Cloudflare Workers Builds/Git integration, which does not require those GitHub secrets. The owner still needs to sign in, connect the repository, set the two Worker runtime secrets and deploy. See [Cloudflare Free Paper Automation](docs/CLOUDFLARE_FREE_PAPER_AUTOMATION.md).

## Market scan evidence

GitHub Actions also runs a separate read-only market scanner using public Binance data. Its report does not create paper positions and does not send orders. The latest archived scan (2026-11-09 04:26:14 UTC, main `b9e67f2eb2ef00f69a19ec4667c562f7a7ea7a23`) returned fresh live data for BTC/USDT ($74,935.52; HOLD, score 40), ETH/USDT ($2,142.81; HOLD, score 30) and SOL/USDT ($87.50; HOLD, score 40). All three were in aligned 1H/6H downtrends and each had 349 clean closed candles on both timeframes, with no gaps, duplicates, malformed rows or off-grid timestamps. The scanner allows at most 5 seconds of future timestamp skew for exchange/runner clock differences; the raw age remains visible in the report, and timestamps beyond that tolerance fail closed. See the [market scanner workflow](.github/workflows/free-cloud-market-scanner.yml).

A HOLD result is intentional when the configured strategy filters do not align. The strategy score is deterministic and uncalibrated; it is not a probability or a forecast.

The read-only scanner now reports ticker and candle-analysis providers plus their quote currencies separately. It downgrades signals to HOLD unless both feeds match exactly, preventing a Binance USDT ticker from being paired with Coinbase USD candles during fallback.

## Strategy research lab

The read-only market scanner now compares three separate spot-long research hypotheses alongside the existing trend signal:

- `trend_pullback`: higher-timeframe uptrend, EMA20 reclaim after a pullback, positive directional strength, controlled RSI and ATR.
- `volatility_breakout`: close above the prior 20-bar high, at least 1.5x relative volume, ADX/positive directional movement and controlled ATR.
- `range_mean_reversion`: range regime on both timeframes, low ADX, RSI at or below 40, and a confirmed reclaim of the lower Bollinger band (not a falling-knife entry).

The lab rejects malformed, gapped, duplicate, off-grid, insufficient or future higher-timeframe candles. Its scores are transparent rule counts, not probabilities or model confidence. It does not connect to the automatic paper executor. Candidate strategies must undergo separate chronological out-of-sample/walk-forward tests, realistic fee/slippage stress and forward PAPER observation before any future promotion.

## Security and limitations

- No profit or positive return is guaranteed. A working bot can still lose money in simulation and live markets.
- The Cloudflare Worker is PAPER-only. The dashboard must remain in PAPER mode.
- The Worker uses public endpoints and does not need exchange credentials. Failed-login throttling is stored in the Durable Object SQLite ledger under a keyed HMAC-SHA-256 source-IP fingerprint; raw IP addresses are not stored by this limiter. Eight attempts are allowed per source in a rolling ten-minute window, and a successful login clears that source's counter. If the limiter is unavailable, login fails closed. Never place passwords, session secrets, exchange API keys, wallet seeds, recovery codes or Cloudflare tokens in source control or chat.
- Cloudflare account creation, acceptance of Cloudflare legal terms, secrets configuration and live deployment remain owner-controlled.
- Cloudflare Free has documented request, CPU, storage and SQL quotas. It is not an unlimited 24/7 compute guarantee. Stop automation if quota or data-quality gates fail; do not upgrade to a paid plan under a ₹0 budget.
- A 15-minute simulated exit monitor is not an exchange-native stop-loss. Fast price gaps, service outages or missed alarms can produce a much worse simulated exit than the trigger level.
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
