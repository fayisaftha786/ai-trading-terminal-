# Install the Android AUTO DEMO APK — v0.7.0

No Termux is required. GitHub Actions builds the installable debug APK from this repository.

1. Open this repository's **Actions** tab.
2. Select **AI Trading Terminal v0.7.0 — Cloud source verification and Android APK**.
3. Run the workflow on the `main` branch and wait for every verification step to pass.
4. Download `AITradingTerminal-Android-v0.7.0-debug-apk` from the Artifacts section. It contains the APK, SHA-256 checksum, and build information.
5. Verify the APK against its checksum before installing it.

## Local DEMO and AUTO DEMO

The on-device terminal uses a $1,000 virtual ledger and $100 fixed-size positions. Modeled fees are 0.10% and slippage 0.05% per side, with a 2% stop-loss and 4% take-profit. The ledger, candle timestamps, and emergency stop are stored locally on the phone.

**AUTO DEMO is OFF by default and requires an explicit in-app opt-in.** It evaluates closed 1-hour and 4-hour candles plus public BTC/USDT ticker, bid/ask spread, top-10 order-book depth, 24-hour quote volume, trend/momentum and modeled round-trip costs. It allows no more than 3 entries per UTC day, one open position at a time, and a 4-hour cooldown. The same signal candle cannot be reused.

Automatic market refresh and stop/target evaluation happen only while the terminal screen is in the foreground, approximately every 5 minutes. Android can suspend the app; this is not a 24/7 service, and a phone/network outage can delay or prevent paper exits. Cached data cannot create automatic entries.

This is a deterministic, explainable paper strategy, not a trained ML model or a profit guarantee. It uses public Binance market data, sends no orders, and does not need exchange API keys. ORIGINAL/LIVE trading remains unavailable and locked. Demo results never automatically enable live trading.

The APK is debug-signed for testing, not Play Store production distribution. Physical-device testing is still required. The cloud dashboard requires a separately deployed HTTPS backend; this workflow does not deploy paid hosting.
