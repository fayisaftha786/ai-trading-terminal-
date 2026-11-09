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

- Cloudflare Workers Free currently documents 100,000 Worker requests/day and 10 ms CPU per normal Worker HTTP/Cron invocation. Durable Objects have a separate default 30-second CPU allowance per request and alarm handlers have a 15-minute wall-time limit. The Worker only routes/authenticates; heavier market analysis runs inside the Durable Object.
- Durable Objects Free currently documents 100,000 requests/day, 13,000 GB-seconds/day, 5 million SQL rows read/day, 100,000 rows written/day, and 5 GB total SQLite storage. If a Free quota is exceeded, further operations of that type fail with an error rather than automatically moving to Paid. Quotas are not an unlimited 24/7 compute guarantee.
- Three instruments × three live snapshot requests (ticker, 24-hour stats and Level-2 book) are used every scan. Validated 1-hour and 6-hour candles are read from the Durable Object archive and refreshed from Coinbase only when the next candle has closed, or when the cache is missing/invalid. Each request is paced at least 350 ms apart; scans use more requests only when a timeframe history refresh is due. A 15-minute cycle is 96 cycles/day when all alarms execute, plus dashboard requests.
- Alarms are at-least-once; the code stores the next alarm timestamp and a bounded 200-cycle idempotency ledger so a retried alarm does not create a second scan/trade cycle. A unique open-position index and per-symbol cooldown provide additional duplicate guards. Alarm scheduling is not an exchange-grade real-time guarantee.
- The user must verify Coinbase public endpoint availability from the deployed Cloudflare region before trusting signals. The code fails closed when endpoints fail, ticker timestamps are stale, candle history is incomplete, spread is wide or depth is low.
- Coinbase Exchange Level-2 REST book snapshots provide a sequence and bid/ask levels, but no reliable exchange event timestamp. The Worker records the local time the order-book response was received and requires that retrieval time to be no more than 15 seconds old at the PAPER entry decision. This verifies recent retrieval by this Worker, not the exchange-side generation time. Missing or stale retrieval time fails closed. The gate is in addition to the top-10 depth threshold.
- Coinbase 24-hour quote volume is estimated as reported base volume × latest price, not an exchange-supplied quote-volume field.
- Strategy signal is a deterministic, uncalibrated rule score, not an ML model or probability.
- Paper fills approximate an ask-plus-slippage entry and bid-minus-slippage exit. They do not model queue position, partial fills, exchange fees actually charged to your account, outages, market impact or latency.
- The 15-minute scheduler can miss a fast price gap. A simulated stop is not an exchange-native stop and cannot guarantee an exit price. Cloudflare Durable Object alarms are at-least-once with retry/backoff; this worker uses durable cycle keys to avoid replaying the same scheduled entry decision.
- No profit is promised. Paper results are not proof of live profitability.

## Market-data and scheduler safety watchdog

- PAPER auto-entry can only be enabled after a recent complete scan verifies all configured BTC/USD, ETH/USD and SOL/USD markets, fresh two-sided quotes, a locally retrieved Level-2 order-book snapshot no older than 15 seconds with at least USD 5,000 of top-10 depth on both bid and ask sides, and at least 150 clean closed candles on both 1H and 6H for every market. These same order-book checks are part of the full-market health gate, not just the later trade-candidate check. It also requires at least one recent successful scheduled alarm scan; a manual **Scan now** cannot stand in for scheduler proof.
- One market with a stale quote, a failed provider request, or a candle-integrity failure blocks the complete market universe from opening new positions. Existing exits continue to be monitored using any fresh available bid marks.
- Three consecutive unhealthy scheduled scans latch-stop new PAPER entries. A gap of more than 45 minutes since the last healthy scheduled scan also latches the stop when the engine next runs. Manual scans do not reset the scheduled failure streak, refresh the scheduled heartbeat, or hide a stopped scheduler. The dashboard reports the actual last scheduled-alarm heartbeat separately from the last manual-or-scheduled scan.
- A watchdog latch is not cleared automatically when Coinbase recovers. Close open paper positions, use **Reset stop lock**, run a fresh complete scan, then explicitly enable PAPER again. This avoids surprise re-entry after an extended data outage.
- The provider's final retry response also retains its Retry-After cooldown in the running Worker isolate so subsequent symbols do not immediately repeat requests while the provider is still rate-limiting the Worker. This cooldown is in-memory; a Worker isolate restart clears it.

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

## Temporary preview deployment (optional)

Cloudflare supports an agent-run temporary preview using Wrangler 4.102.0 or later and `wrangler deploy --temporary`. This can deploy a Worker and supported Durable Object migrations before the owner has a permanent Cloudflare account. The preview remains available for 60 minutes. The owner must accept Cloudflare's Terms of Service and Privacy Policy, then complete the claim flow within that 60-minute window; otherwise Cloudflare deletes the temporary account and its resources. The claim URL is a bearer credential and must only be delivered to the intended owner. This is a short verification/claim bridge, not a permanent production account or ongoing CI/CD setup.

Official guide: https://developers.cloudflare.com/workers/platform/claim-deployments/

## Setup through Cloudflare Dashboard (no Termux or local Node install)

This is the recommended route for a phone-only setup. Cloudflare Workers Builds can connect a GitHub repository and deploy on pushes. Cloudflare can generate its own deployment token for that integration; do not create or share a token in chat.

1. Open [Cloudflare Dashboard](https://dash.cloudflare.com/) and sign in or create your own account. Use the Free plan only. Do not choose an upgrade, paid add-on or billing-based plan.
2. Open **Workers & Pages** → **Create application** → choose **GitHub**. Authorize the Cloudflare GitHub app for this repository only if GitHub offers a repository-selection screen.
3. Select repository `fayisaftha786/ai-trading-terminal-` and production branch `main`.
4. Configure the Worker from the repository root:
   - Root directory: leave the field blank/default so Cloudflare uses the repository root
   - Build command: `npm run check && npm test`
   - Deploy command: `npx wrangler@4 deploy --tag "$WORKERS_CI_COMMIT_SHA" --message "Git commit $WORKERS_CI_COMMIT_SHA"`
   - Worker name must remain `ai-trading-terminal`, matching `wrangler.jsonc`
   - Workers Builds provides `WORKERS_CI_COMMIT_SHA`; this tag is exposed at runtime through `CF_VERSION_METADATA`.
   - Do not add D1, KV, R2, Queues, Containers, paid compute, or any other product. The required SQLite Durable Object is declared in `wrangler.jsonc`.
5. Select **Save and Deploy**. The first deployment applies the SQLite Durable Object migration. A failed login before secrets are configured is expected; no trading will start.
6. Open the new Worker → **Settings** → **Variables and Secrets** → **Add** → **Secret**. Add these two runtime secrets:
   - `ADMIN_PASSWORD`: a unique password at least 16 characters long.
   - `SESSION_SECRET`: a randomly generated secret at least 32 characters long.
   Save/deploy the Worker after adding both secrets. Do not reuse your GitHub or email password, and never send either value here. `ADMIN_USERNAME` defaults to `admin`; it can be overridden as a non-secret variable.
7. Open the Worker URL ending in `.workers.dev`. Check `/api/health` returns `status: ok`, `mode: paper_only`, `live_trading_enabled: false`, and `binance_testnet_enabled: false`. It also returns `worker_version.id`, `worker_version.tag` (the Git commit SHA when deployed with the command above), and a version timestamp. Compare the tag with the repository `main` SHA before treating the new deployment as current.
8. Sign into the dashboard. Press **Scan now**. Wait for all 3 market rows to show `live`; verify both 1h and 6h have at least 150 valid closed candles, no gaps, fresh quotes, local order-book response retrieval age under 15 seconds and adequate top-10 depth. If any item is unavailable or stale, leave automatic PAPER entries OFF.
9. Confirm the scan timestamp advances after the first alarm and again roughly every 15 minutes. Refresh the page and confirm the virtual ledger, events and stop state persist. Do not enable PAPER auto-entry before this check.
10. Only after the above checks, use the dashboard's **Enable paper auto-entry** button. This authorizes virtual PAPER trades only. Real trading and Binance Testnet remain disabled.
11. The Android APK/WebView can be pointed to the Worker HTTPS URL only after the browser dashboard and its authenticated APIs have passed these checks.

### GitHub Actions deploy workflow (separate from Cloudflare Git integration)

The repository also contains `.github/workflows/deploy-cloudflare-worker.yml`. It is **manual-dispatch only** and requires two GitHub repository Actions secrets:

- `CLOUDFLARE_API_TOKEN` — a narrowly scoped Cloudflare API token with permission to deploy this Worker.
- `CLOUDFLARE_ACCOUNT_ID` — the target Cloudflare account identifier.

These GitHub Actions secrets are separate from the Worker's runtime secrets (`ADMIN_PASSWORD` and `SESSION_SECRET`). On 2026-11-08, the repository Actions secrets page showed that both required deployment secret names were missing. Add them yourself under GitHub → repository **Settings** → **Secrets and variables** → **Actions** before using **Actions** → **Deploy Cloudflare Worker** → **Run workflow**. Never paste their values into chat, commit them, or put them in ordinary workflow variables. Until these secrets exist, the manual GitHub Actions deployment cannot run. Cloudflare Dashboard Git integration can be used instead and does not require these GitHub Actions secrets.

Cloudflare's Git integration instructions: [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) and [build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/). Runtime secrets are configured separately from build variables; see [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

### Optional command-line route

For a trusted computer with Node.js 22+:
```sh
npm install
npx wrangler@4 deploy --tag "$GITHUB_SHA" --message "Git commit $GITHUB_SHA"
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
```
The dashboard Git integration route above avoids needing Termux or a local Node installation.

## Secret and deployment safety

- Never put Cloudflare tokens, dashboard passwords, Coinbase credentials, exchange keys, wallet seeds or SSH private keys in GitHub source files, APKs, issue comments or chat.
- If CI-based deployment is later used, store a narrowly scoped Cloudflare API token as a GitHub Actions secret in the repository settings yourself. It is not required for the manual deploy documented above.
- Never use the Cloudflare Workers Paid plan to solve a quota or CPU issue under the ₹0 constraint. Stop and disable new paper entries if free quotas or limits are reached.
- Keep a backup/export process before using the paper ledger for long-term research. Durable Object SQLite is the authoritative single-object ledger; do not horizontally split or change its object name.
- Account creation, email verification, account recovery, billing configuration and deploy authorization remain user-controlled. This PR cannot create a Cloudflare account or deploy without the user's authenticated Cloudflare session.

## Verification scope

GitHub Actions runs JavaScript syntax checks, strategy-unit tests, a Wrangler dry-run build and a local workerd smoke test of the Durable Object, session gate, paper opt-in, stop/reset and static dashboard. These do not prove that Cloudflare deployment, Coinbase network access from the user's Cloudflare region, actual scheduled alarm cadence, account-level Free quotas or Android WebView connectivity work in the user's Cloudflare account. Those still require a live post-deployment check.


The local smoke test runs Wrangler in local workerd mode and checks SQLite Durable Object initialization, unauthenticated API rejection, owner login, dashboard reads, explicit PAPER enable, emergency stop, reset and static asset serving. It uses disposable local test credentials and makes no cloud deployment.
