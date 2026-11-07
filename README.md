# AI Trading Terminal — v0.5.0 Cloud Edition

This repository is being prepared for the no-Termux cloud backend and Android debug APK build.

## Source upload required

Upload `AITradingTerminal-v0.5.0-No-Termux-Cloud-Source.zip` from the supplied release package to the repository root. The GitHub Actions workflow will unpack it in a clean runner, run the backend release checks, and build a debug APK. Do not upload `.env` files, exchange API keys, passwords, or production secrets.

## Safety status

- Live-money trading remains disabled.
- Testnet is for verification only.
- The debug APK is not a production-signed release.
- Cloud deployment requires configuring secrets and persistent storage separately.
