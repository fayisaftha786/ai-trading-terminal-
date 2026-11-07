# No-Termux Cloud Deployment — AI Trading Terminal 0.7.0

## ലക്ഷ്യം

Android ഫോണിൽ Termux, Python, Gradle, Android SDK എന്നിവ ഇൻസ്റ്റാൾ ചെയ്യാതെ private cloud backend ഉപയോഗിക്കുക. Android APK ഒരു HTTPS dashboard client മാത്രമാണ്; market scanner, scheduler, database എന്നിവ cloud service-ൽ പ്രവർത്തിക്കും.

## Architecture

- Android APK / mobile browser → HTTPS → FastAPI cloud service.
- Private dashboard login → short-lived HMAC-signed bearer token.
- Production API endpoints require `Authorization: Bearer ...`.
- SQLite ledger lives under `/var/data/trading.db` on a Render persistent disk.
- One Uvicorn worker and one service instance are required: the scheduler is process-local and SQLite is a single-writer persistent volume.
- **Automatic PAPER mode is persisted in SQLite.** If it was explicitly enabled before a restart, it can resume after restart. The persisted emergency-stop / drawdown breaker state must be checked and remains a gate against new entries when latched.
- **Testnet automatic entries are different:** the strategy-driven Binance OPOCO auto-entry switch is forced OFF after every backend restart. Existing exchange-side TP/SL exits are still reconciled. Production/live order execution remains hard-locked.
- The strategy-driven Binance Spot Testnet OPOCO implementation is in draft PR #15 and is not part of `main` until it is reviewed and merged. Do not assume it is deployed or enable it before a real Spot Testnet lifecycle check.

## Deploy on Render using only the browser

1. Use the existing GitHub repository `fayisaftha786/ai-trading-terminal-` (or a private fork you control). Do not create a second source repository or upload a ZIP as a replacement for the Git repository.
2. Open Render Dashboard → **New → Blueprint** and connect that repository. Render reads the root `render.yaml`.
3. The Blueprint asks you to provide `APP_PASSWORD`. Set a unique password of at least 16 characters. `APP_AUTH_SECRET` is generated automatically by Render. Do not reuse an exchange password.
4. Review the proposed resources before deploying. The Blueprint configures a Starter web service and a 1 GB persistent disk mounted at `/var/data`. Automatic redeploy is disabled; deploy updates manually after checking GitHub CI.
5. **Do not press Create/Deploy until you accept the displayed price.** The service is not free. The cost section below is a published-price estimate, not a billing guarantee.
6. When the service is live, open `https://<service-name>.onrender.com/api/health`. It should return `status: ok`, `mode: paper_only`, and `live_trading_enabled: false`.
7. Open the root HTTPS URL in the browser; the private sign-in overlay should appear. Use the `admin` username and the dashboard password configured in Render.
8. In the Android APK, enter the same HTTPS service URL. The APK accepts HTTPS origins only; sign in on the dashboard after it loads.

## Current Render cost and limits

The configured legacy Starter web-service plan is listed at USD $7/month, and a 1 GB Render persistent disk is USD $0.25/GB/month. The Hobby workspace is listed at $0/month. This is approximately **USD $7.25/month before bandwidth, taxes, and other usage**. Render pricing can change; verify the current [official pricing page](https://render.com/pricing) and the exact Blueprint estimate before creating resources.

Render Free web services spin down after 15 minutes without inbound traffic, do not support persistent disks, and are not suitable for this app's continuously running stateful scheduler with a persistent SQLite ledger. A free service is not a 24/7 trading worker.

## Important operational constraints

- Keep exactly one instance and one Uvicorn worker while using the SQLite persistent disk.
- Automatic PAPER mode is a simulation, not exchange execution. It is persisted when explicitly enabled; check its state and the kill switch after every deploy/restart.
- Exchange Testnet switches are OFF in the Blueprint. Do not place exchange credentials in the Android app, browser storage, or GitHub repository.
- If adding Testnet later, add only Spot Testnet keys through Render's protected environment variables. Never use production credentials in Testnet variables.
- The OPOCO automatic Testnet feature remains in draft PR #15 until review/merge. A passing CI run is not a substitute for authenticated Spot Testnet order, fill, TP/SL, fee, restart, and emergency-stop tests.
- `APP_PASSWORD` changes take effect after redeploy. Existing bearer tokens remain valid until expiry (up to the configured 8-hour lifetime); restart/redeploy to invalidate them sooner.
- The in-memory login throttle is a basic single-instance safeguard, not an enterprise identity or distributed rate-limiting system.
- Cloud availability is not guaranteed by this package. Monitor Render health and logs.
- The database is not automatically backed up by the app. Configure and test an independent backup/export plan before using important data.

## APK build (also browser-only)

The workflow is named **AI Trading Terminal v0.7.0 — Cloud source verification and Android APK**. It runs when Android source files, `build-android-debug.sh`, or the workflow file itself change, and it can also be started manually with `workflow_dispatch`. A backend-only push does not rebuild the APK because the Android client has not changed.

1. Open the repository → **Actions** → select the v0.7.0 workflow.
2. For a manual build, select **Run workflow** on the `main` branch.
3. Open the successful run → **Artifacts** → `AITradingTerminal-Android-v0.7.0-debug-apk`.
4. Download and extract the artifact. It includes the APK, SHA-256 checksum, and build information. Verify the APK against the included `.sha256` file before installing.
5. Successful push/manual runs publish or refresh the `v0.7.0-debug` GitHub Release. Pull-request runs upload an artifact only and do not publish a release.

The APK is debug-signed for testing, not Play Store production distribution. A physical Android 16 install and cloud-backend connection check are still required.

## Test checklist

- [ ] `/api/health` works without a bearer token and reveals no secrets.
- [ ] `/api/dashboard` returns 401 before login.
- [ ] Incorrect password returns 401; repeated failures are throttled.
- [ ] Valid login returns a bearer token; dashboard loads with it.
- [ ] Invalid/expired token returns 401 and browser requests a fresh sign-in.
- [ ] DB rows still exist after a service restart/redeploy.
- [ ] Confirm PAPER automation state explicitly after restart; it may resume if previously enabled.
- [ ] Confirm the PAPER emergency-stop / drawdown breaker remains latched when it was activated.
- [ ] Testnet order gate and production/live trading remain OFF by default.
- [ ] Testnet automatic-entry switch is OFF after every backend restart.
- [ ] APK accepts HTTPS only and loads the cloud dashboard on Android 16.
- [ ] No production/live-money order is submitted.
