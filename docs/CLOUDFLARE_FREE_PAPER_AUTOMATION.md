# Cloudflare Free Paper Automation — AI Trading Terminal

## Purpose and safety boundary

This package is an alternative cloud runtime for the AI Trading Terminal. It uses a single SQLite-backed Cloudflare Durable Object for persistent paper positions and an alarm that repeats approximately every 15 minutes. The account owner must explicitly enable automatic PAPER entries in the dashboard; the initial state is OFF.

This is not unattended real-money trading. Production/live exchange orders are not implemented here. Binance Testnet order execution is not part of this Worker. Solana token discovery and wallet signing are not part of this Worker. No exchange API key is required.

## Architecture

- Cloudflare Worker: same-origin API gateway, password login, signed short-lived session token and static dashboard.
- Durable Object TradingEngine: serialized single-owner paper ledger in SQLite, risk gates, market snapshots, events and emergency stop state.
- Durable Object alarm: repeats a public market scan every 15 minutes, monitors paper stops/targets and schedules its next alarm.
- Coinbase Exchange public REST market-data endpoints: ticker, 24-hour stats, level-2 book, 1-hour candles and 6-hour candles for BTC-USD, ETH-USD and SOL-USD.
- No D1 database, KV namespace, paid container, load balancer, VPS or paid service is required by this design.

The Durable Object alarm is initialized on the first /api/health or authenticated API request. The dashboard probes health during its initial load. If the object is not invoked, its alarm does not start.

## Free-plan limits and honest expectations

- Cloudflare Workers Free currently documents 100,000 Worker requests/day and 10 ms CPU per normal Worker HTTP/Cron invocation. Durable Objects have a separate default 30-second CPU allowance per invocation and SQLite-backed storage is available on Free. The Worker only routes/authenticates; the heavier market analysis runs inside the Durable Object.
- Durable Objects Free currently documents 100,000 requests/day, 13,000 GB-seconds/day, and 5 GB total account SQLite storage. Quotas are not an unlimited 24/7 compute guarantee.
- Three instruments × five public requests are used per scan. Requests are paced at least 350 ms apart (about 2.9 requests/second) to remain below Coinbase public REST limits; each full scan is roughly 5.3 seconds of request pacing plus network latency. A 15-minute cycle is 96 cycles/day when all alarms execute, plus dashboard requests.
- Alarms are at-least-once; the code stores the next alarm timestamp and a bounded 200-cycle idempotency ledger so a retried alarm does not create a second scan/trade cycle. A unique open-position index and per-symbol cooldown provide additional duplicate guards. Alarm scheduling is not an exchange-grade real-time guarantee.
- The user must verify Coinbase public endpoint availability from the deployed Cloudflare region before trusting signals. The code fails closed when endpoints fail, timestamps are stale, candle history is incomplete, spread is wide or depth is low.
- The Coinbase order-book timestamp is not included in the app's market snapshot; local retrieval time is recorded as weaker provenance. A paper candidate still needs adequate top-10 depth.
- Coinbase 24-hour quote volume is estimated as reported base volume × latest price, not an exchange-supplied quote-volume field.
- Strategy signal is a deterministic, uncalibrated rule score, not an ML model or probability.
- Paper fills approximate an ask-plus-slippage entry and bid-minus-slippage exit. They do not model queue position, partial fills, exchange fees actually charged to your account, outages, market impact or latency.
- The 15-minute scheduler can miss a fast price gap. A simulated stop is not an exchange-native stop and cannot guarantee an exit price. Cloudflare Durable Object alarms are at-least-once with retry/backoff; this worker uses durable cycle keys to avoid replaying the same scheduled entry decision.
- No profit is promised. Paper results are not proof of live profitability.

## Default risk controls

- PAPER starting equity: USD 100 of virtual funds only.
- Risk budget per entry: 0.25% of paper equity.
- Maximum total exposure: 20%.
- Maximum open positions: 3.
- Maximum entries per UTC day: 3.
- Per-symbol cooldown: 4 hours.
- Stop distance: 1%; take-profit distance: 3%.
- Estimated fee: 15 bps per side; estimated slippage: 10 bps.
- Daily loss stop: 1.5%; weekly loss stop: 4%; peak-to-trough stop: 5%.
- Only one eligible entry per scan.

These are initial conservative assumptions for a simulation; review them after measured paper data. The 15 bps fee assumption is not a statement of your actual Coinbase fee tier.

## Setup without paid resources

1. Create a free Cloudflare account using your own contact details. No account or Cloudflare resources are created by this repository change. Confirm the dashboard shows the Free plan and do not enter any paid upgrade or billing step.
2. Install Node.js 22+ and npm on a trusted computer. Install Wrangler locally:
   npm install --save-dev wrangler
3. Install dependencies:
   npm install
4. Set the two Worker secrets using Wrangler prompts. Do not paste them into chat or commit them:
   npx wrangler secret put ADMIN_PASSWORD
   npx wrangler secret put SESSION_SECRET
   Use a unique dashboard password of at least 16 characters and a random session secret of at least 32 characters. ADMIN_USERNAME may be set as a non-secret var in wrangler.jsonc or as a Worker variable; the default is admin.
5. Deploy only after verifying that Wrangler targets the Free plan and this one SQLite Durable Object:
   npx wrangler deploy
6. Open the Worker URL in a browser. The first /api/health request initializes the recurring Durable Object alarm. Sign in with the configured username/password. Confirm the API says paper_only, live_trading_enabled=false, and Binance Testnet is disabled.
7. Confirm Coinbase data status is live for all three pairs, candle integrity shows 150+ closed candles on both timeframes, and scan time advances. If it says unavailable or reports provider errors, do not enable paper automation.
8. Automatic PAPER entry is initially OFF. Review the displayed conditions and deliberately enable it from the dashboard only after verifying provider availability.
9. Set up your Android app's WebView start URL to the deployed HTTPS Worker URL only after the web dashboard has passed health, authentication, scheduled-scan and persistence checks.

## Secret and deployment safety

- Never put Cloudflare tokens, dashboard passwords, Coinbase credentials, exchange keys, wallet seeds or SSH private keys in GitHub source files, APKs, issue comments or chat.
- If CI-based deployment is later used, store a narrowly scoped Cloudflare API token as a GitHub Actions secret in the repository settings yourself. It is not required for the manual deploy documented above.
- Never use the Cloudflare Workers Paid plan to solve a quota or CPU issue under the ₹0 constraint. Stop and disable new paper entries if free quotas or limits are reached.
- Keep a backup/export process before using the paper ledger for long-term research. Durable Object SQLite is the authoritative single-object ledger; do not horizontally split or change its object name.
- Account creation, email verification, account recovery, billing configuration and deploy authorization remain user-controlled. This PR cannot create a Cloudflare account or deploy without the user's authenticated Cloudflare session.

## Verification scope

GitHub Actions runs JavaScript syntax checks, strategy-unit tests and a Wrangler dry-run build. These do not prove that Cloudflare deployment, Coinbase network access, Durable Object alarms, account-level Free quotas or Android WebView connectivity work in the user's Cloudflare account. Those require a live post-deployment check.
