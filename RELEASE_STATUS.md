# Release status — AI Trading Terminal v0.7.1

**Status:** Android debug APK published successfully on 2026-11-07.

## Android release

- Version name: `0.7.1`
- Version code: `48`
- Package: `app.aitradingterminal.debug`
- Minimum SDK: `26`
- Target SDK: `35`
- APK size: `46,364 bytes`
- Signing: Android debug key (testing only; not production-signed)
- Main commit: `369aaac4d3d5191e8a0648a675c3dc5327301bbb`
- GitHub release: https://github.com/fayisaftha786/ai-trading-terminal-/releases/tag/v0.7.1-debug
- Direct APK: https://github.com/fayisaftha786/ai-trading-terminal-/releases/download/v0.7.1-debug/AITradingTerminal-Android-v0.7.1-debug.apk
- SHA-256 asset: https://github.com/fayisaftha786/ai-trading-terminal-/releases/download/v0.7.1-debug/AITradingTerminal-Android-v0.7.1-debug.apk.sha256

## v0.7.1 changes

- Local Android PAPER entry uses ask and close uses bid.
- Manual PAPER actions reject missing, invalid, future or stale ticker quotes and stale local order-book retrievals.
- Cached prices cannot be used to open or close positions after a failed market refresh.
- Click-time quote checks complement disabled/stale UI controls.
- Added regression tests for quote freshness and validity.

## Verification

- PR #25 was merged to main.
- Main-branch Android release workflow completed successfully, including the full release gate, Gradle build, APK signature/metadata verification, artifact upload and GitHub Release publication.
- Backend tests, Python/release checks and the read-only market scanner workflow completed successfully for the main commit.
- Cloudflare Worker validation includes JavaScript syntax, unit tests, Wrangler dry-run and local workerd smoke tests for initialization, authentication, explicit PAPER opt-in, kill switch, reset and static dashboard serving.
- A follow-up full-code audit identified and is correcting two cloud PAPER safety issues: Coinbase L2 freshness was relying on an undocumented REST book `time` field, and dashboard reads could update portfolio high-water marks/risk baselines from stale cached quotes. The fix is being tested in a separate PR; it is not part of the v0.7.1 APK.

**Not verified:** physical installation on the owner's Vivo device, Cloudflare account deployment, regional Coinbase access from that account, actual 15-minute alarm cadence or a forward paper-trading sample.

## Market scan — 2026-11-07 16:41 UTC

The GitHub scheduled read-only scanner used public Binance market data:

| Symbol | Data | Signal | 1h regime | 6h regime |
|---|---|---|---|---|
| BTC/USDT | Live | HOLD | DOWNTREND | DOWNTREND |
| ETH/USDT | Live | HOLD | DOWNTREND | DOWNTREND |
| SOL/USDT | Live | HOLD | RANGE_OR_TRANSITION | DOWNTREND |

All three markets had 349 valid candles in both analyzed timeframes, with no reported missing intervals, duplicate timestamps, malformed rows or off-grid timestamps. All signals were HOLD. This scanner is read-only: it sent no orders and created no paper positions.

## Cloud backend status

The Cloudflare PAPER Worker source is merged into main and passed local validation. **It is not deployed to a Cloudflare account.** The remaining deployment requires the owner to use a Cloudflare account on the Free plan, connect the GitHub repository, and configure `ADMIN_PASSWORD` (16+ characters) and `SESSION_SECRET` (32+ characters) as Cloudflare runtime secrets. Do not send these secrets in chat or commit them to GitHub.

After deployment, verify `/api/health`, owner authentication, all three live markets, 1h/6h candle integrity, fresh local order-book response retrieval age, ledger persistence and the alarm schedule. Keep automatic PAPER entries OFF until all checks pass.

## Safety boundary

- Cloudflare Worker reports `mode: paper_only`.
- Worker health explicitly reports `live_trading_enabled: false` and `binance_testnet_enabled: false`.
- Automatic PAPER entries default OFF and require explicit owner opt-in.
- No real-money trading, guaranteed profit or production-signed Android build is claimed.
- Cloudflare Free is quota-limited; no paid plan or resource is required or authorized under the ₹0 budget.
