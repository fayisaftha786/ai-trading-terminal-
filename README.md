# AI Trading Terminal — v0.5.0 No-Termux Cloud Edition

This repository contains the GitHub Actions delivery workflow for the Android debug APK. The exact source package is verified by SHA-256 before any build is attempted.

## Current source package

Upload this exact file to the repository root:

`AITradingTerminal-v0.5.0-No-Termux-Cloud-Source.zip`

Expected SHA-256:

`4a4d1fa4e95023d1e0a416ff40e81feb4466d221844359f895d19a69d841b9bb`

The source package includes Supabase PostgreSQL cloud-storage support, the applied ledger migration under `supabase/migrations/`, the Render Free Blueprint, backend API, tests, dashboard, and Android Gradle project. SQLite remains available for local development and tests.

## One-time upload

1. Download the exact source ZIP from the release package supplied in this conversation.
2. Open the repository's **Code** tab: https://github.com/fayisaftha786/ai-trading-terminal-
3. Choose **Add file → Upload files**.
4. Upload the ZIP itself to the repository root. Do not extract it, rename it, or place it inside another folder.
5. Commit the upload to the `main` branch.

The `cloud-apk.yml` workflow starts automatically when that exact source file is added. It checks SHA-256, extracts the source, runs `scripts/master_release.py`, builds the Android debug APK, verifies APK metadata/signature, and uploads the build outputs as an Actions artifact.

## APK download

1. Open https://github.com/fayisaftha786/ai-trading-terminal-/actions
2. Open the newest successful **AI Trading Terminal v0.5.0** run.
3. Under **Artifacts**, download `AITradingTerminal-Android-v0.5.0-debug-apk`.
4. Extract the artifact ZIP and install the APK on Android.

The artifact is a debug build, not a Play Store or production-signed release. It is retained for 30 days.

## Cloud deployment

The included Render Blueprint uses the Free web-service plan and Supabase PostgreSQL for persistent ledger storage. Render Free can sleep after inactivity, so background market scanning is not continuous or guaranteed 24/7. Add `DATABASE_URL`, `APP_PASSWORD` (at least 16 characters), and the generated `APP_AUTH_SECRET` in Render's protected environment settings. Never place database or exchange credentials in the APK, frontend, Git, or chat. The app validates the Supabase ledger schema at startup and requires the ledger migration to have been applied first.

## Verification status

- Source archive SHA-256: verified locally against this expected value.
- Source static release gate: PASS.
- Python test suite: 142 passed.
- Android APK: **not yet built**; a successful GitHub Actions run is required before an APK can be claimed as ready.
- Render deployment and authenticated exchange Testnet execution: not yet end-to-end verified.

## Trading safety

- Live-money trading remains disabled.
- Automatic strategy execution is paper-only.
- Testnet is disabled by default and intended for separate verification.
- No guaranteed profit is claimed.
- Never commit `.env` files, exchange API keys, passwords, recovery codes, or production secrets.
