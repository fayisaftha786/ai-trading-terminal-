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
- A follow-up full-code audit fix was merged in PR #27 (main commit `813376a96eab70214d3cfb596a15904202e2b8bb`): Coinbase L2 freshness now uses an explicitly labelled local response-retrieval time, stale/crossed ticker snapshots cannot mark portfolio positions, and incomplete marks cannot update the equity high-water mark or create new daily/weekly risk baselines. Regression tests cover the new gates. These Worker fixes do not change the v0.7.1 Android APK.

A further PAPER entry hardening fix was merged in PR #28 (main commit `99532b93b09c8a55543bea6b2d9a79cb3856cd97`): the last closed 1h analysis is limited to 90 minutes of age and the 6h confirmation to 7 hours; missing/non-finite timeframe metrics and invalid fee/slippage assumptions fail closed. Regression tests cover stale candles and invalid assumptions. The PR validation and post-merge `main` validation both passed syntax checks, unit tests, Wrangler dry-run build and local Durable Object/authentication/kill-switch smoke test. This is a Cloud Worker change and does not require an Android APK rebuild.

**Not verified:** physical installation on the owner's Vivo device, exact deployed Cloudflare Git commit (the version tag is blank), repeat 15-minute alarm cadence, regional Coinbase access from that account or a forward paper-trading sample.

## Latest market scan — 2026-11-09 04:24:09 UTC

The GitHub scheduled read-only scanner used public Binance data on current main commit `0d54d15209828393cd9ee457e98abae9b2c40111`:

| Symbol | Data | Last | Signal | Score | 1H regime | 6H regime | Spread |
|---|---|---:|---|---:|---|---|---:|
| BTC/USDT | Live | $74,860.92 | HOLD | 40 | DOWNTREND | DOWNTREND | 0.0013 bps |
| ETH/USDT | Live | $2,139.50 | HOLD | 30 | DOWNTREND | DOWNTREND | 0.0467 bps |
| SOL/USDT | Live | $87.29 | HOLD | 40 | DOWNTREND | DOWNTREND | 2.2910 bps |

All three markets were fresh and had 349 clean closed candles on both 1H and 6H, with no gaps, duplicates, malformed rows or off-grid timestamps. All signals were HOLD because both timeframes were in a downtrend; no trade candidate qualified. SOL's ticker age was approximately -742 ms (exchange timestamp slightly ahead of runner clock), within the scanner's documented 5-second clock-skew tolerance; the raw age remains visible. Future timestamps beyond that tolerance are rejected. The scan was read-only: no orders were sent and no paper positions were created. GitHub schedules are best-effort, not a continuous 24/7 trading server.

## Cloud backend status

**Audit updated 2026-11-09.** The public Cloudflare Worker URL currently responds with HTTP 200 and declares `mode=paper_only`, `live_trading_enabled=false` and `binance_testnet_enabled=false`. The `worker_version.tag` is blank, so the exact current-main revision is still **unverified**. The public response now includes scheduler telemetry and at the latest check reported `scheduler.status=healthy`, `last_scheduled_scan_status=completed`, and an alarm/healthy-scan age of approximately 8.5 minutes. This confirms a recent scheduled cycle, but a second observation is still needed to confirm recurring 15-minute cadence.

Current GitHub `main`: `0d54d15209828393cd9ee457e98abae9b2c40111`. Main has passed backend/release verification, read-only scanner, Worker validation/local Durable Object smoke tests, and ARM64 Docker build/runtime smoke tests. Recent main changes add a public-safe scheduled-alarm heartbeat, 15-minute production watchdog, exact comparison to current main SHA, and explicit market-data provider/quote-currency fields.

The previous GitHub Actions deployment attempt passed source checks, all 25 Worker unit tests and Wrangler dry-run build, then stopped at the credential check because `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` were empty. The recommended phone-only route is Cloudflare Dashboard → Workers & Pages → GitHub integration; this can create its own deployment authorization and avoids requiring those two GitHub Actions secrets. The owner must still sign in, connect the repository, and configure Cloudflare runtime secrets `ADMIN_PASSWORD` (16+ characters) and `SESSION_SECRET` (32+ characters). Never share them in chat or commit them.

After deploying, verify that `worker_version.tag` exactly equals current `main`, check the scheduler heartbeat and last healthy scheduled scan, confirm all 3 markets, candle integrity, local order-book response retrieval age, ledger persistence and kill-switch behavior. Keep automatic PAPER entries OFF until these checks pass.

## Safety boundary

- Cloudflare Worker reports `mode: paper_only`.
- Worker health explicitly reports `live_trading_enabled: false` and `binance_testnet_enabled: false`.
- Automatic PAPER entries default OFF and require explicit owner opt-in.
- No real-money trading, guaranteed profit or production-signed Android build is claimed.
- Cloudflare Free is quota-limited; no paid plan or resource is required or authorized under the ₹0 budget.
