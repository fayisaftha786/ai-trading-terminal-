# AI Trading Terminal — v0.5.0 Cloud Edition

This repository contains the GitHub Actions delivery workflow for the no-Termux Android debug APK. The release source archive is verified by an exact SHA-256 check before any build is attempted.

## Release source upload

The exact source archive must be uploaded to the repository root with this filename:

`AITradingTerminal-v0.5.0-No-Termux-Cloud-Source.zip`

Expected SHA-256:

`78a1ab88566e497e0b018e0f33d5458593963c8c758b542156002993d899621b`

The companion checksum file is `AITradingTerminal-v0.5.0-No-Termux-Cloud-Source.zip.sha256`.

### One-time GitHub upload

1. Download the source ZIP from the release package supplied in this conversation.
2. Open the repository's **Code** tab: https://github.com/fayisaftha786/ai-trading-terminal-
3. Choose **Add file → Upload files**.
4. Upload the ZIP itself to the repository root. Do not extract it, rename it, or place it inside another folder.
5. Commit the upload to the `main` branch.

The `cloud-apk.yml` workflow starts automatically when that exact source file is added. It checks the SHA-256, extracts the source, runs `scripts/master_release.py`, builds the Android debug APK, verifies the APK metadata/signature, and uploads the build outputs as an Actions artifact.

### Download the APK after a successful run

1. Open https://github.com/fayisaftha786/ai-trading-terminal-/actions
2. Open the newest successful **AI Trading Terminal v0.5.0** run.
3. Under **Artifacts**, download `AITradingTerminal-Android-v0.5.0-debug-apk`.
4. Extract the artifact ZIP and install the APK on the Android device.

The artifact is a debug build, not a Play Store or production-signed release. The workflow retains it for 30 days.

## Verification status

- Source archive SHA-256: verified against the release checksum.
- Source static release gate: PASS.
- Python test suite: 136 passed.
- Android APK: **not yet built**; a successful GitHub Actions run is required before an APK can be claimed as ready.
- Cloud deployment and authenticated exchange Testnet execution: not yet end-to-end verified.

## Trading safety

- Live-money trading remains disabled.
- Testnet is for verification only.
- This project does not guarantee profit.
- Never commit `.env` files, exchange API keys, passwords, recovery codes, or production secrets.
- Cloud deployment requires separately configured secrets, persistent storage, HTTPS, backups, and monitoring.
