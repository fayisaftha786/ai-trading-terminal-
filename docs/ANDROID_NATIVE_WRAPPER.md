# Android native wrapper — Cloud Edition 0.5.0

The Android app is a thin WebView client. It does not include Python or exchange credentials. On first launch, enter the private backend's HTTPS origin (for example, `https://your-service.onrender.com`). The wrapper rejects HTTP, localhost, IP-only hosts, embedded credentials, query strings, and URL paths.

The WebView permits only same-origin navigation. External HTTPS links open in the browser; SSL certificate errors are rejected. File/content access and mixed content are disabled. Android cleartext traffic is disabled for every host.

Production API authentication is performed by the dashboard sign-in form using a short-lived bearer token held in `sessionStorage` for the active WebView tab. Do not enter exchange keys into the APK.

GitHub Actions builds a debug APK through `build-android-debug.sh`, validates package metadata and signing, writes a SHA-256 checksum, and uploads the artifact. The debug APK is for testing, not Play Store distribution. The working environment does not contain an Android SDK/build-tools installation, so the APK must be built by the CI runner and then installed on a physical device for verification.
