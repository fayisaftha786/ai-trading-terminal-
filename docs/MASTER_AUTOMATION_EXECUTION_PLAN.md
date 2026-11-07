# Master Automation Execution Plan — Cloud Edition 0.5.0

## Current architecture

The Android app is a thin HTTPS dashboard client. The Python FastAPI service, market scanning loop, SQLite ledger, and paper-trading engine run on a private cloud service. The Android device does not need a local Python environment.

## Release state

- Cloud password login and short-lived HMAC bearer authentication are implemented for production mode.
- The browser UI obtains a token from `/api/auth/login`; protected `/api/*` routes require the token.
- Android WebView only accepts HTTPS cloud origins and does not allow cleartext traffic.
- Render Blueprint includes a single paid web service, one persistent disk, one process, and secret configuration.
- Automatic paper mode is opt-in and resets OFF after service restart.
- Binance Spot Testnet stays disabled by default and only supports an isolated manual LIMIT path behind its separate gate.
- Live-money exchange execution and Solana wallet signing are not implemented.

## Required next verification after deployment

1. Verify Render service is continuously live and the health endpoint reports `paper_only` and `live_trading_enabled=false`.
2. Verify login success, wrong-password rejection, login throttle, invalid token rejection, and token expiry.
3. Restart/redeploy the service and confirm SQLite ledger data remains on the persistent disk.
4. Confirm the background scanner runs only on one instance/worker and auto paper remains OFF after restart.
5. Build the 0.5.0 debug APK in GitHub Actions, verify its APK signature and checksum, and install on Android 16.
6. Confirm the installed APK connects to the HTTPS backend and can authenticate.
7. Only then run market-data and paper-mode observations. Do not send real-money orders.

## Guardrails

- Do not expose the development configuration publicly. Production requires `APP_ENV=production`, a unique 16+ character `APP_PASSWORD`, a random 32+ byte `APP_AUTH_SECRET`, and an absolute `DATABASE_PATH` on persistent storage.
- Do not scale this SQLite deployment horizontally or increase Uvicorn workers. The scheduler and paper-broker entry lock are process-local.
- Use only provider secret settings for exchange credentials. Do not put keys into APK, frontend, source control, screenshots, or chat.
- 100% profit is not possible to guarantee. Strategy scores are deterministic rule scores, not calibrated probabilities.
- Free Render instances are not suitable for continuous trading: they sleep and do not provide persistent disks. The Blueprint selects the low-cost paid persistent configuration.
