# AI Trading Terminal v0.7.1 — No-Termux PAPER Edition

AI Trading Terminal is an Android-friendly crypto market research and paper-trading project. The current published Android package is a **debug/test APK**. The Cloudflare Worker URL is responding as a **PAPER-only backend**; the public health check was successful on 2026-11-08. That confirms reachability and its declared safety mode, but does not prove which Git commit is currently deployed or that scheduled scans are healthy.

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

**Deployment status (2026-11-08):** The public Worker endpoint `https://ai-trading-terminal.fayisaftha786.workers.dev/api/health` responds with `status: ok`, `mode: paper_only`, `live_trading_enabled: false` and `binance_testnet_enabled: false`. The latest research-archive and Coinbase cooldown fixes are merged to `main` and passed GitHub validation, but their deployment to the production Worker is **not verified**. The repository's manual GitHub Actions deploy workflow is currently blocked because `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are not configured as Actions secrets. Cloudflare Dashboard Git integration is a separate deployment route. See [Cloudflare Free Paper Automation](docs/CLOUDFLARE_FREE_PAPER_AUTOMATION.md).

## Market scan evidence

GitHub Actions also runs a separate read-only market scanner using public Binance data. Its report does not create paper positions and does not send orders. The 2026-11-07 scan returned live data for BTC/USDT, ETH/USDT and SOL/USDT; all three signals were HOLD. See the [market scanner workflow](.github/workflows/free-cloud-market-scanner.yml).

A HOLD result is intentional when the configured strategy filters do not align. The strategy score is deterministic and uncalibrated; it is not a probability or a forecast.

## Security and limitations

- No profit or positive return is guaranteed. A working bot can still lose money in simulation and live markets.
- The Cloudflare Worker is PAPER-only. The dashboard must remain in PAPER mode.
- The Worker uses public endpoints and does not need exchange credentials. Never place passwords, session secrets, exchange API keys, wallet seeds, recovery codes or Cloudflare tokens in source control or chat.
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
