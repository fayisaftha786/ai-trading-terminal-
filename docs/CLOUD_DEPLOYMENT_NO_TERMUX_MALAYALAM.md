# No-Termux Cloud Deployment — AI Trading Terminal 0.5.0

## ലക്ഷ്യം

Android ഫോണിൽ Termux, Python, Gradle, Android SDK ഒന്നും ഇൻസ്റ്റാൾ ചെയ്യാതെ private cloud backend ഉപയോഗിക്കുക. Android APK ഒരു HTTPS dashboard client മാത്രമാണ്; trading engine cloud service-ൽ പ്രവർത്തിക്കും.

## Architecture

- Android APK / mobile browser → HTTPS → FastAPI cloud service.
- Private dashboard login → short-lived HMAC-signed bearer token.
- API endpoints require `Authorization: Bearer ...` in production.
- SQLite ledger lives under `/var/data/trading.db` on a Render persistent disk.
- One Uvicorn worker and one service instance are required: the scheduler is process-local and SQLite is on a single-writer persistent volume.
- Automatic paper mode resets OFF after every service restart. Live trading remains hard-locked; Coinbase live order execution remains locked by default.

## Deploy on Render using only the browser

1. Create a new **Private** GitHub repository named `ai-trading-terminal`. Do not add a README, license, or template.
2. On the phone, extract the provided source ZIP with the Files app. In GitHub's browser page, open **Add file → Upload files**, then upload the extracted project contents while preserving folder paths. Do not upload only the ZIP: Render needs a repository containing `Dockerfile`, `render.yaml`, `app/`, `static/`, `android/`, and `tests/`.
3. Open Render Dashboard → **New → Blueprint** and connect the private repository.
4. Render reads `render.yaml`. The Blueprint asks you to provide `APP_PASSWORD`. Set a unique password of at least 16 characters. `APP_AUTH_SECRET` is generated automatically by Render. Do not reuse an exchange password.
5. Review the proposed resources and deploy the first service. Automatic redeploy on every repository push is disabled so you can inspect GitHub CI before manually deploying updates. The configured service uses the Starter compute plan and a 1 GB persistent disk mounted at `/var/data`.
6. When the service is live, open `https://<service-name>.onrender.com/api/health`. It should return `status: ok`, `mode: paper_only`, and `live_trading_enabled: false`.
7. Open the root HTTPS URL in the browser; the private sign-in overlay should appear. Use the `admin` username and the dashboard password configured in Render.
8. In the Android APK, enter the same HTTPS service URL. The APK accepts HTTPS origins only; sign in on the dashboard after it loads.

## Current Render cost and limits

The configured Starter web service is currently listed at USD $7/month and the 1 GB Render persistent disk at USD $0.25/GB/month. The Hobby workspace itself is listed at $0/month. This is approximately **USD $7.25/month before bandwidth, taxes, and any other usage**. Verify the provider's pricing page before creating resources; prices and plans can change.

Render Free web services spin down after 15 minutes without inbound traffic, lose local filesystem changes on restarts/redeploys, and do not support persistent disks. Therefore Free is not configured for a 24/7 stateful trading worker.

## Important operational constraints

- Keep exactly one instance and one Uvicorn worker while using the SQLite persistent disk.
- Do not enable auto paper trading until the backend has been checked after deployment. It is a simulation only.
- Live order execution remains OFF. Do not place exchange credentials in the Android app or GitHub repository.
- Store any approved Coinbase credentials only in protected server environment variables, with transfer and withdrawal permissions disabled.
- `APP_PASSWORD` changes take effect after redeploy. Existing bearer tokens remain valid until expiry (up to the configured 8-hour lifetime); restart/redeploy to invalidate them sooner.
- The in-memory login throttle is a basic single-instance safeguard, not an enterprise identity or distributed rate-limiting system.
- Cloud availability is not guaranteed by a free tier or by this package. Monitor Render health and logs.
- The database is not automatically backed up by the app. Configure and test an independent backup/export plan before using important data.

## APK build (also browser-only)

GitHub Actions builds the Android debug APK after each push. Open the repository → **Actions** → `CI and Android debug build` → latest successful run → **Artifacts** → `AITradingTerminal-Android-v0.5.0-debug-apk`. Download and extract the artifact, then check the `.sha256` file against the APK with a checksum utility on a trusted computer. The included APK is debug-signed for testing, not Play Store release.

## Test checklist

- [ ] `/api/health` works without a bearer token and reveals no secrets.
- [ ] `/api/dashboard` returns 401 before login.
- [ ] Incorrect password returns 401; repeated failures are throttled.
- [ ] Valid login returns a bearer token; dashboard loads with it.
- [ ] Invalid/expired token returns 401 and browser requests a fresh sign-in.
- [ ] DB rows still exist after a service restart/redeploy.
- [ ] Automatic paper mode is OFF after restart.
- [ ] Coinbase live order execution remains OFF.
- [ ] APK accepts HTTPS only and loads the cloud dashboard on Android 16.
- [ ] No real-money order is submitted.
