# Cloudflare Free Paper Automation — AI Trading Terminal

## Purpose and safety boundary

This package is an alternative cloud runtime for the AI Trading Terminal. It uses a single SQLite-backed Cloudflare Durable Object for persistent paper positions and a 90-second strategy/candle scan and a separate 10-second L2-only refresh alarm. The account owner must explicitly enable automatic PAPER entries in the dashboard; the initial state is OFF. Profile v2 forces legacy v1 auto-entry settings OFF during migration. A new/empty ledger targets USD 10 virtual capital. If a legacy ledger has trades and a different starting balance, it stays locked until the owner reviews it; the review can preserve the existing starting balance and all history, requires all open positions to be closed, and keeps auto-entry OFF.

This is not unattended real-money trading: automatic live entries are not implemented. The Worker contains an optional Coinbase Advanced SPOT LIMIT GTC post-only path for manually previewed and separately owner-confirmed orders, but it remains locked until account preflight, product eligibility, permissions, limits and the execution secret are verified. Binance Testnet order execution is not part of this Worker, and Binance is not used as an account or execution connector in the dashboard. Solana token discovery and wallet signing are not part of this Worker. No exchange API key is required.

## Architecture

- Cloudflare Worker: same-origin API gateway, password login, signed short-lived session token and static dashboard.
- Durable Object TradingEngine: serialized single-owner paper ledger in SQLite, risk gates, market snapshots, events and emergency stop state.
- Durable Object alarm: a 10-second alarm refreshes only L2 books from each market's already-selected venue; full strategy/candle scans remain at 90 seconds. The short path may check existing PAPER exits but never generates an entry. This is still a scheduled simulation, not a real-time exchange stop.
- Coinbase is the primary USD spot market-data provider. Bitstamp's public USD spot API is a secondary whole-market fallback for BTC/USD, ETH/USD and SOL/USD: ticker, grouped order-book snapshot, native 1H candles (`step=3600`) and native 6H candles (`step=21600`). If the primary snapshot is unavailable or incomplete, the Worker retries that symbol as a complete Bitstamp snapshot; it never combines a Coinbase ticker/book with Bitstamp candles. Each selected market records `market_data_provider` and the provider for ticker, book, 1H and 6H so source mixing fails the market-universe gate.
- No D1 database, KV namespace, paid container, load balancer, VPS or paid service is required by this design.

The Durable Object alarm is initialized on the first /api/health or authenticated API request. The dashboard probes health during its initial load. If the object is not invoked, its alarm does not start. Each next alarm is scheduled about 90 seconds after the current cycle completes; this is not a guaranteed fixed-rate 90-second market-data feed.

## Free-plan limits and honest expectations

- Cloudflare Workers Free currently documents 100,000 Worker requests/day and 10 ms CPU per normal Worker HTTP/Cron invocation. Durable Objects have a separate default 30-second CPU allowance per request and alarm handlers have a 15-minute wall-time limit. The Worker only routes/authenticates; heavier market analysis runs inside the Durable Object.
- Durable Objects Free currently documents 100,000 requests/day, 13,000 GB-seconds/day, 5 million SQL rows read/day, 100,000 rows written/day, and 5 GB total SQLite storage. If a Free quota is exceeded, further operations of that type fail with an error rather than automatically moving to Paid. Quotas are not an unlimited 24/7 compute guarantee.
- Each instrument normally uses two live snapshot requests per scan from the selected provider: ticker and Level-2 book. The ticker's own 24-hour base-volume field is used for quote-volume estimation; `/stats` is requested only if that field is absent or malformed. Validated 1-hour and 6-hour candles are read from that provider's own Durable Object archive and refreshed only when the next candle has closed, or when the cache is missing/invalid. Each provider's requests are paced at least 350 ms apart. A fallback attempt adds requests only for the affected market. Bitstamp fallback requires a `SPOT` ticker and a fresh exchange-timestamped book. If a secondary endpoint is incomplete, current valid bid/ask marks can still be retained for PAPER exits, but new entries stay blocked. A 90-second cycle is 960 alarms/day when all alarms execute. At the normal baseline of two public snapshot requests per market, that is about 5,760 venue REST requests/day across three markets before occasional candle refreshes and secondary-provider failover. The worker paces requests at least 350 ms apart (under 2.9 requests/second); Coinbase Exchange documents a 10 requests/second public REST limit per IP with bursts up to 15. Cloudflare request/CPU quotas and retry behaviour still need live monitoring.
- Alarms are at-least-once; the code stores the next alarm timestamp and a bounded 200-cycle idempotency ledger so a retried alarm does not create a second scan/trade cycle. A unique open-position index and per-symbol cooldown provide additional duplicate guards. Alarm scheduling is not an exchange-grade real-time guarantee.
- The user must verify both public-provider routes from the deployed Cloudflare region before trusting signals. Coinbase is primary; Bitstamp is a backup, not a blended data source. New entries fail closed when the locally received ticker observation or exchange event timestamp is stale/future, the selected provider's product is not spot, candle history is incomplete or too old, ticker/book/candle providers do not match, the order book is unavailable, spread is too wide, or either side's top-10 depth is below USD 5,000.
- Coinbase Exchange Level-2 REST book snapshots provide a sequence and bid/ask levels but no reliable exchange event timestamp; for Coinbase the Worker therefore enforces local response-retrieval age (maximum 15 seconds). Bitstamp grouped order-book responses include an exchange timestamp; the Worker checks both local retrieval age and exchange timestamp age (maximum 15 seconds). Missing, future or stale time evidence fails closed. Both providers must also meet the USD 5,000 minimum top-10 depth on each side.
- Coinbase and Bitstamp 24-hour quote volume are estimated as provider-reported base volume × latest price, not as a provider-supplied quote-volume field. Bitstamp failover candles are stored under the separate `bitstamp_spot` provider key. The archive inserts only candles newer than its provider-specific cursor rather than re-writing the 160–200 bar lookback on every scan; offline strategy-tournament runs continue to use Coinbase-only history so unlike venue histories are not silently blended.
- Strategy signal is a deterministic, uncalibrated rule score, not an ML model or probability.
- Paper fills approximate an ask-plus-slippage entry and bid-minus-slippage exit. They do not model queue position, partial fills, exchange fees actually charged to your account, outages, market impact or latency.
- A PAPER position records the exact USD spot provider used at entry. Open-position marks, simulated stops/targets and manual closes accept quotes only from that same provider; if a market switches between Coinbase and Bitstamp, that position is temporarily unmarked until its entry provider returns. Legacy positions opened before provider provenance was recorded are treated as Coinbase entries. This prevents simulated P&L from silently switching venues mid-trade.
- The 10-second L2 refresh reduces the stale-book window but can still miss a fast price gap or provider outage. A simulated stop is not an exchange-native stop and cannot guarantee an exit price. Cloudflare Durable Object alarms are at-least-once with retry/backoff; this worker uses durable cycle keys to avoid replaying the same scheduled entry decision.
- No profit is promised. Paper results are not proof of live profitability.

## Authentication abuse protection

- Failed-login attempts are recorded in the single TradingEngine Durable Object SQLite database, so the limiter is shared across Worker isolates and survives Worker restarts.
- The limiter stores an HMAC-SHA-256 fingerprint of the Cloudflare-provided source IP, keyed with the Worker session secret; it does not store the raw address. It allows at most eight attempts per source in a rolling ten-minute window; a successful login clears that source's attempt history.
- If the Durable Object rate-limit check or reset cannot be completed, login fails closed with a service-unavailable response. This keeps the authentication path dependent on the durable limiter rather than silently falling back to per-isolate memory.
- This is a per-source throttling layer, not a replacement for strong unique passwords, Cloudflare platform protections or session revocation.

## Market-data and scheduler safety watchdog

- PAPER auto-entry can only be enabled after a recent complete scan verifies all configured BTC/USD, ETH/USD and SOL/USD markets, a recently received two-sided ticker observation, a valid non-future selected-provider ticker timestamp, a locally retrieved same-provider Level-2 order-book snapshot no older than 15 seconds with at least USD 5,000 of top-10 depth on both bid and ask sides, and at least 150 clean closed candles on both 1H and 6H for every market from that same provider. The latest closed candle must also be within the explicit freshness window (90 minutes for 1H and 7 hours for 6H). The Coinbase primary or Bitstamp fallback must supply a complete, internally consistent snapshot for each market. These same checks are part of the full-market health gate, not just the later trade-candidate check. It also requires at least one recent successful scheduled alarm scan; a manual **Scan now** cannot stand in for scheduler proof.
- One market with a stale ticker observation, a failed required provider request, an unavailable/stale order book, or a candle-integrity/freshness failure blocks the complete market universe from opening new positions. A recently received valid bid/ask snapshot is kept separately from the last-trade timestamp, so a quiet last-trade timestamp or an optional book/candle failure does not discard an otherwise fresh bid for PAPER exit monitoring. If the ticker request itself fails, no new bid is fabricated and the position remains unmarked until a fresh quote is retrieved.
- Three consecutive unhealthy scheduled scans latch-stop new PAPER entries. A gap of more than 45 minutes since the last healthy scheduled scan also latches the stop when the engine next runs. Manual scans do not reset the scheduled failure streak, refresh the scheduled heartbeat, or hide a stopped scheduler. The dashboard reports the scheduled-alarm heartbeat separately from the last scan. The public `/api/health` endpoint now separates scheduler heartbeat, last completed scan results and current persisted market-snapshot health. `scheduler.status=healthy` means an alarm heartbeat is recent; it does **not** mean an old quote/book remains fresh. `market_data_status` and `scan_diagnostics.current_market_feed` are recalculated from the current snapshots on every health request; prior scan counts are exposed as `last_scan_healthy_market_count`. The dashboard separately labels “Last scan markets” and “Current snapshots”. Provider diagnostics include selected venue, failover state, quote/book/candle ages and refresh errors. Old runtime records with only human-readable error strings still reconstruct issue/provider summaries; credentials and raw provider payloads are not exposed.
- The market-data watchdog clears its latch only after two consecutive complete healthy scheduled scans. It resumes automatic PAPER entries only when the owner had explicitly enabled auto-entry before the watchdog halt and that permission remains persisted. If auto-entry was OFF before the halt, recovery leaves it OFF; the owner must then pass the fresh complete scheduled-scan gate and explicitly enable it. Owner emergency stops and total-drawdown halts do not auto-resume; they require explicit owner review.
- The provider's final retry response also retains its Retry-After cooldown in the running Worker isolate so subsequent symbols do not immediately repeat requests while the provider is still rate-limiting the Worker. This cooldown is in-memory; a Worker isolate restart clears it.

## Default risk controls

- New/empty PAPER profile starting equity: USD 10 of virtual funds only; USD 2 remains reserved and the position notional ceiling is USD 8.
- Risk budget per entry: 1% of current paper equity, reduced further by adaptive risk when drawdown/loss streaks rise.
- Maximum total exposure: 80%; maximum open positions: 1.
- Maximum completed BUY→SELL round trips per UTC day: 5; this is a ceiling, not a target.
- Per-symbol cooldown: 4 hours.
- Stop-loss distance: 1%; take-profit is dynamically selected from estimated round-trip costs and 1H ATR, with unsafe targets rejected.
- Estimated fee: 60 bps per side; estimated slippage: 10 bps per side. The fee is a conservative placeholder, not the owner’s verified Coinbase tier.
- Daily loss stop: 1%; weekly loss stop: 4%; peak-to-trough stop: 5%; soft daily/weekly lock begins at 75% of those limits.
- A legacy ledger with recorded trades and a starting balance other than USD 10 is never silently rebased. After all open positions are closed, the owner may explicitly review and preserve the existing virtual starting balance and historical trades. This review keeps automatic PAPER entries OFF.

All limits are simulation controls, not guarantees or promises of return.

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
   - Deploy command: `npx wrangler@4 deploy --tag "$WORKERS_CI_COMMIT_SHA" --var "DEPLOY_COMMIT_SHA:$WORKERS_CI_COMMIT_SHA" --message "Git commit $WORKERS_CI_COMMIT_SHA"`
   - Worker name must remain `ai-trading-terminal`, matching `wrangler.jsonc`
   - Workers Builds provides `WORKERS_CI_COMMIT_SHA`; the tag is exposed at runtime through `CF_VERSION_METADATA`, while `--var DEPLOY_COMMIT_SHA:...` is what the public health endpoint checks against the Git commit. Setting only the tag leaves `deployment_commit_sha` null.
   - Do not add D1, KV, R2, Queues, Containers, paid compute, or any other product. The required SQLite Durable Object is declared in `wrangler.jsonc`.
5. Select **Save and Deploy**. The first deployment applies the SQLite Durable Object migration. A failed login before secrets are configured is expected; no trading will start.
6. Open the new Worker → **Settings** → **Variables and Secrets** → **Add** → **Secret**. Add these two runtime secrets:
   - `ADMIN_PASSWORD`: a unique password at least 16 characters long.
   - `SESSION_SECRET`: a randomly generated secret at least 32 characters long.
   Save/deploy the Worker after adding both secrets. Do not reuse your GitHub or email password, and never send either value here. `ADMIN_USERNAME` defaults to `admin`; it can be overridden as a non-secret variable.
7. Open the Worker URL ending in `.workers.dev`. Check `/api/health` returns `status: ok`, `mode: paper_only`, `live_trading_enabled: false`, and `binance_testnet_enabled: false`. It also returns `deployment_commit_sha`, `worker_version.id`, `worker_version.tag`, and a version timestamp. Both `deployment_commit_sha` and `worker_version.tag` must match the exact current repository `main` SHA before treating the deployment as current.
8. Sign into the dashboard. Press **Scan now**. Wait for all 3 market rows to show `live`; verify both 1h and 6h have at least 150 valid closed candles, no gaps, fresh quotes, local order-book response retrieval age under 15 seconds and adequate top-10 depth. If any item is unavailable or stale, leave automatic PAPER entries OFF.
9. Confirm the L2 refresh timestamp advances roughly every 10 seconds with 3/3 successes, while the full strategy scan advances roughly every 90 seconds. Confirm the 15-second order-book gate remains in force, then refresh the page and verify that the virtual ledger, events and stop state persist. Do not enable PAPER auto-entry before this check.
10. Only after the above checks, use the dashboard's **Enable paper auto-entry** button. This authorizes virtual PAPER trades only. Real-money order submission is disabled in this build; Coinbase account preflight and order preview do not place an order. Binance Testnet remains disabled.
11. The Android APK/WebView can be pointed to the Worker HTTPS URL only after the browser dashboard and its authenticated APIs have passed these checks.

### GitHub Actions deploy workflow (production deployment path)

The repository workflow `.github/workflows/deploy-cloudflare-worker.yml` runs on every push to `main` and also supports manual dispatch. It runs source checks, the Node test suite, a Wrangler dry-run build, verifies that Cloudflare deployment credentials are present, deploys the Worker and checks the public health endpoint against the exact Git commit SHA. The successful 2026-11-10 run verified commit `da73f33611663a6b1e45ede253d6eea01bbf7be5` and confirmed PAPER-only mode, live trading OFF and Binance Testnet OFF. This establishes that the two GitHub Actions deployment secrets were configured and accepted at that run; it does not prove that a later independent Cloudflare deployment has not replaced that Worker version.

- `CLOUDFLARE_API_TOKEN` — a narrowly scoped Cloudflare API token with permission to deploy this Worker.
- `CLOUDFLARE_ACCOUNT_ID` — the target Cloudflare account identifier.

These GitHub Actions secrets are separate from the Worker's runtime secrets (`ADMIN_PASSWORD` and `SESSION_SECRET`). Never paste their values into chat, commit them, or put them in ordinary workflow variables.

**Use one production deployment source of truth.** The GitHub Actions workflow already deploys on `main` pushes. If Cloudflare Workers Builds is also enabled for the same production Worker, either disable its automatic deployment or configure the command above so it sets both `worker_version.tag` and `deployment_commit_sha` to the same `WORKERS_CI_COMMIT_SHA`. Otherwise a second deployment can replace the verified GitHub Actions revision and leave the health endpoint unable to prove which source commit is running.

Cloudflare's Git integration instructions: [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) and [build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/). Runtime secrets are configured separately from build variables; see [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

### Optional command-line route

For a trusted computer with Node.js 22+:
```sh
npm install
npx wrangler@4 deploy --tag "$GITHUB_SHA" --var "DEPLOY_COMMIT_SHA:$GITHUB_SHA" --message "Git commit $GITHUB_SHA"
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

Official secondary-provider reference: [Bitstamp Public API v2](https://www.bitstamp.net/api/) — public spot ticker, grouped order-book, OHLC fields and published request limits.


## Research-quality upgrades (PAPER and offline only)

The research dashboard compares three exploratory strategy families. A single backtest or parameter search is not a promotion gate. The hardening branch adds:

- Chronological walk-forward evaluation with at least 3,000 clean 1H bars and 500 clean 6H bars, an initial higher-timeframe warmup, and four non-overlapping test folds of at least 28 days each (three sequential validation folds plus an untouched final holdout).
- Explicit out-of-sample trade counts per strategy. Fewer than 30 aggregate test-fold trades is labelled as an insufficient research sample, not a validated strategy.
- A 500-path deterministic trade-order shuffle and moving-block bootstrap on exploratory trade returns. It reports drawdown under reordered trade sequences, return percentiles and the fraction of resampled paths that lose money. This is a sensitivity diagnostic, not a probability forecast, and it cannot model every future regime change.
- Intrabar stop/target conflict counts, next-bar-open entries, adverse stop-first collision resolution, fees and slippage. The drawdown mark includes estimated exit slippage and fees.
- Dashboard status that distinguishes exploratory performance from the untouched holdout, 2x cost stress and Monte Carlo tails.

The current research history archive retains up to 4,320 1H bars and 1,440 6H bars per asset/provider. The new walk-forward gate therefore needs roughly 125 days of clean 6H/1H history to become available. It will correctly report insufficient history until the archive has accumulated enough data. This does not delay ordinary 1H/6H signal monitoring; it delays only the stronger research-validation claim.

External research references: [Freqtrade look-ahead analysis](https://www.freqtrade.io/en/stable/lookahead-analysis/), [Freqtrade recursive indicator analysis](https://www.freqtrade.io/en/stable/recursive-analysis/), [Hummingbot V2 architecture](https://hummingbot.org/strategies/v2-strategies/), [Jesse optimization and held-out testing](https://docs.jesse.trade/docs/research/optimize), and [Probability of Backtest Overfitting (Bailey et al.)](https://doi.org/10.21314/jcf.2016.322).


## Two-cadence scheduler and BTC-context hardening (2026-11-10)

- **10 seconds:** refresh the order book only, using the exact provider selected for the symbol (Coinbase or Bitstamp). Update L2 telemetry and check existing PAPER exits. This path does not calculate new entry signals and cannot open positions.
- **90 seconds:** refresh closed-candle research, recalculate the 1H/6H strategy and cross-market context, assess all entry gates, and run the scheduled PAPER cycle.
- **15 seconds:** hard maximum age for an order-book snapshot. If a refresh is missed, fails validation, receives stale Bitstamp exchange time, or returns low/invalid depth, the current feed is unavailable and new entries remain blocked. Do not raise this limit to make the dashboard appear healthy.

The strategy uses a BTC-led 1H/6H market regime and breadth gate plus rolling ATR-expansion checks. Walk-forward evidence is research-only and can qualify a candidate for a separately reviewed shadow-PAPER trial; it cannot switch on auto-entry or authorize live orders.
