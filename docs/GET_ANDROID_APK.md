# Get the Android debug APK — Cloud Edition 0.5.0

No Termux is required. GitHub Actions builds this APK directly from the current repository source.

1. Open this repository's **Actions** tab.
2. Select **AI Trading Terminal v0.5.0 — Cloud source verification and Android APK**.
3. Choose **Run workflow** on the `main` branch. The workflow builds directly from the current repository source; no old source ZIP upload is required.
4. Wait for the workflow to finish successfully.
5. Download `AITradingTerminal-Android-v0.5.0-debug-apk` from the Artifacts section. It contains the APK, SHA-256 checksum, and build information.
6. Verify the APK against its checksum before installing it.
7. On first launch, enter your private cloud backend's HTTPS URL. Sign in with the dashboard username/password configured on that backend.

The APK is debug-signed for testing. It has not been physically tested on a Vivo Android 16 device by this build workflow. A separate secure release-signing key is required for a Play Store/release build.

The APK is only a client; the Python trading backend must be deployed and running in the cloud. The Cloud Blueprint defaults live trading and Binance Testnet orders to OFF.
