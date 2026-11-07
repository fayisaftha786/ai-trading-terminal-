# AI Trading Terminal — No-Termux Cloud Edition

Backend API: `0.5.0-cloud` · Android client: `0.7.0` (debug)

A private, cloud-hosted crypto market research and paper-trading dashboard with an Android WebView client. No Python runtime or Termux is needed on the Android phone after the cloud backend is deployed.

## What changed from 0.4.4

- Added production-only API authentication with a private sign-in form and HMAC-signed short-lived bearer sessions.
- Added a basic per-IP login failure throttle and secure response headers.
- Android native wrapper now accepts HTTPS cloud origins only; HTTP and loopback URLs are rejected.
- Replaced the local-only network security exceptions with an all-host cleartext deny policy.
- Added a Render Blueprint with a persistent 1 GB database disk, HTTPS health check, secret generation, and Testnet OFF defaults.
- Docker uses one Uvicorn worker because the scan scheduler and SQLite ledger are single-process components.
- Removed Termux launcher and Termux-only requirements from this release.
- Android client version is 0.7.0 / versionCode 47; the cloud API has its own `0.5.0-cloud` version.

## Features

- Read-only CEX market data and Solana token discovery.
- Deterministic market analysis, historical backtesting, walk-forward research, and performance reports.
- On-demand 12-worker read-only market analysis with bounded concurrency, worker health, isolated failures, and a visible unavailable state for unconfigured news sentiment.
- Manual paper positions and automatic paper-trading controls.
- Risk limits, drawdown checks, event ledger, stop/target monitoring, and emergency stop.
- `main` includes a separate Binance Spot Testnet manual LIMIT order flow, disabled by default and isolated from production. Draft PR #15 adds strategy-driven OPOCO auto-entry with native TP/SL exits; that branch feature requires a fresh opt-in after every backend restart and has not yet passed authenticated Spot Testnet end-to-end verification.
- Testnet auto-trading uses fresh closed-candle 1h/4h alignment, order-book depth/spread and liquidity gates, bounded sizing, daily entry/loss stops, persistent order reconciliation, fee-aware realized P&L and emergency stop.
- Live-money order execution is hard-disabled. Solana swap signing/execution is not implemented.

## Deployment

Follow [`docs/CLOUD_DEPLOYMENT_NO_TERMUX_MALAYALAM.md`](docs/CLOUD_DEPLOYMENT_NO_TERMUX_MALAYALAM.md). The Render Blueprint requires a paid Starter service and persistent disk for an always-on single-instance backend. The current published baseline is about USD $7.25/month before bandwidth/tax/other usage; recheck pricing before deploy.

## APK

GitHub Actions built and verified the `AITradingTerminal-Android-v0.7.0-debug.apk` artifact and published the `v0.7.0-debug` release. The artifact includes SHA-256 and build metadata. It is debug-signed for testing; a physical Android 16 install and cloud-backend connection test are still outstanding. Follow [`docs/GET_ANDROID_APK.md`](docs/GET_ANDROID_APK.md).

## Security model and limitations

- Production API requests require `Authorization: Bearer` using an HMAC token issued after password login.
- `APP_PASSWORD` must be at least 16 characters; `APP_AUTH_SECRET` must be at least 32 bytes. Use the hosting provider's secret manager.
- Tokens are stored in browser `sessionStorage` for the active tab and expire after the configured period (default eight hours).
- The built-in login throttle is per-process and best-effort. This is single-user private deployment, not a multi-user identity system.
- Run one service instance and one Uvicorn worker while the SQLite persistent disk is used.
- Explicit paper-trading opt-in and kill-switch state persist across ordinary restarts; the kill switch and drawdown breaker keep new entries OFF.
- The 12-worker analysis is on-demand and read-only; it does not authorize or submit orders. See [docs/MULTI_AGENT_WORKERS.md](docs/MULTI_AGENT_WORKERS.md).
- Strategy-driven Testnet OPOCO automation is currently in draft PR #15 and is not part of `main` until reviewed and merged. Latest mocked CI covers OPOCO lifecycle and safety branches, but no authenticated Spot Testnet execution has been performed. Keep all Testnet gates OFF until real Spot Testnet OPOCO lifecycle, partial-fill, commission-ledger, restart and emergency-stop checks are manually verified.
- The Testnet daily loss guard covers this bot's exact-fee, completed trades in UTC; it is not an account-wide equity stop. After a backend restart, native exchange exits are reconciled automatically but new Testnet entries remain OFF until explicitly enabled again.
- No real-money trading, profit guarantee, trained ML model, free 24/7 cloud runtime, or unattended wallet signing is included.

## Local development

Install `requirements.txt`, copy `.env.example` to `.env`, keep `APP_ENV=development`, and run `uvicorn app.main:app --host 127.0.0.1 --port 8000`. Development mode is intentionally unauthenticated and must never be exposed publicly.

## Release checks

```bash
python scripts/master_release.py
```

The release gate runs Python compilation, pytest, JavaScript syntax, shell syntax, and static security checks, then creates a source archive only when every gate passes.
