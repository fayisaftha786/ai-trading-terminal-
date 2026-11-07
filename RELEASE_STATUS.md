# Release status — v0.5.0 Cloud Edition

- Cloud backend production authentication added (username/password login; HMAC bearer tokens; token expiry).
- Login attempts throttled per client address in the single app process.
- Render Blueprint defines a paid single-instance web service with a 1 GB persistent disk.
- Docker starts one Uvicorn worker only; this matches the process-local scheduler and SQLite ledger design.
- Android WebView accepts HTTPS cloud origins only; cleartext traffic is disabled.
- Automatic paper mode still resets OFF after restart.
- Binance Testnet order access remains disabled by default; production/live order route remains locked.
- Android package target/min SDK: 35/26; versionCode 45; versionName 0.5.0.
- APK is not built or physically installed until GitHub Actions actually completes successfully.
