# Get the Android debug APK — Cloud Edition 0.5.0

No Termux is required. GitHub Actions builds this APK in the cloud.

1. Create a new private GitHub repository and upload the extracted project folder tree (not just the ZIP archive).
2. Open the repository's **Actions** tab.
3. Select **CI and Android debug build** and open the latest successful run.
4. Download `AITradingTerminal-Android-v0.5.0-debug-apk` from the Artifacts section.
5. Extract the artifact. It contains the APK, SHA-256 checksum, and build information.
6. Verify the APK against its checksum before installing it.
7. On first launch, enter your private cloud backend's HTTPS URL. Sign in with the dashboard username/password you configured with the cloud host.

The APK is debug-signed for testing. It has not been physically tested on a Vivo Android 16 device by this build workflow. A separate secure release-signing key is required for a Play Store/release build.

The APK is only a client; the Python trading backend must be deployed and running in the cloud. The Cloud Blueprint defaults live trading and Binance Testnet orders to OFF.
