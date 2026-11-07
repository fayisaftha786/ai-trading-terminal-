# Install the Android DEMO APK — v0.6.0

No Termux is required. GitHub Actions builds the APK directly from this repository.

1. Open this repository's **Actions** tab.
2. Select **AI Trading Terminal v0.6.0 — Cloud source verification and Android APK**.
3. Run the workflow on the `main` branch and wait for every verification step to pass.
4. Download `AITradingTerminal-Android-v0.6.0-debug-apk` from the Artifacts section. It contains the APK, SHA-256 checksum, and build information.
5. Verify the APK against its checksum before installing it.

## Use the local DEMO mode

Open the app and choose **OPEN ON-DEVICE PAPER TERMINAL**. A cloud backend is not required for this local demo. The simulated wallet starts with $1,000 virtual capital and uses a $100 position size. Its assumptions are 0.10% fee per side, 0.05% slippage per fill, a 2% stop-loss, and a 4% take-profit. Candle timestamps and the paper ledger are saved locally on the phone.

**Important limits:** this is a paper simulation, not an exchange account. Automatic stop/target exits are evaluated only when the app successfully refreshes complete, closed 1-hour candles while the app is running. Android may suspend background activity; this is not a 24/7 execution service. Cached market data cannot open new positions, and a manual close on cached data is only an estimate. Live-money order execution is not implemented and remains disabled.

The APK is debug-signed for testing, not Play Store distribution. It has not been physically tested on a Vivo Android 16 device. The optional cloud dashboard requires a separately deployed HTTPS backend; no paid hosting is included.
