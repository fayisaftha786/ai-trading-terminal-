# AI Trading Terminal

Coinbase-only crypto market research and paper-trading platform with a Cloudflare Durable Object engine and an Android-friendly dashboard.

## Exchange scope

- Coinbase is the only supported centralized-exchange account/order connector and the only provider for ordinary market scans and all new PAPER entries. A narrow Bitstamp read-only compatibility path may continue marking an already-open legacy PAPER position that was originally opened from Bitstamp data; it cannot create new entries or affect the BTC-led entry context.
- Solana token discovery through Jupiter is research and screening only; it does not submit swaps.
- Coinbase Advanced Trade account connectivity and guarded order workflows remain separate features. They require explicit owner configuration, fresh preflight checks, bounded limits and confirmation.

## Execution safety

- Automatic strategy execution remains PAPER-only. Paper automation never sends exchange orders.
- Real Coinbase order execution remains locked unless the separate Coinbase Advanced Trade authorization and server-side safeguards are deliberately configured.
- No profitability or future-return guarantee is made. Backtests and paper results are not evidence of future profits.
- Keep API credentials in private deployment secrets. Never commit keys or paste them into chat.
- The Cloudflare server scheduler runs strategy/candle scans on a 90-second cadence and performs a separate L2-only refresh targeted at 10 seconds. Missing, stale or invalid data blocks new entries.
- Cloud AUTO PAPER entries start disabled and require the owner to enable them after reviewing the health and risk settings. The server-side market scanner can continue collecting and evaluating market data while entries are disabled.
- The Android cloud app is a thin client for the private Worker; it does not store Coinbase credentials. Its separate on-device PAPER mode uses public BTC-USD data and a local virtual ledger. On-device AUTO DEMO refreshes every five minutes only while that screen remains in the foreground; it is not a 24/7 background service and does not submit real orders.

## Coinbase PAPER liquidity gate

The Coinbase Exchange PAPER market-universe and candidate gates measure quote-notional depth across the first 50 available L2 price levels on each side, rather than only the first 10. Coinbase books can contain many very small fragmented price levels near the touch; a top-10-only sum could mark a genuinely deep market as illiquid. The minimum remains USD 5,000 per side, the strict 15-second book freshness limit remains in force, and the spread, quote-volume, market-regime, portfolio, fee/slippage and risk checks are unchanged. A missing, malformed, crossed, stale or genuinely shallow book still blocks new entries.

## Coinbase L2 Shadow Trading

The independent Shadow ledger is separate from the ordinary PAPER ledger. It uses Coinbase Advanced Trade's public product-book endpoint for execution estimates and walks up to 25 visible bid/ask levels, records modeled VWAP, a separate Shadow fee assumption and an adverse slippage buffer, preserves partial fills, and estimates exits against fresh Advanced Trade bid depth. `SHADOW_FEE_BPS_PER_SIDE` controls the Shadow-only fee assumption (default 10 bps/side); it is not automatically synchronized with the private Coinbase account tier and must be updated if the account's taker fee changes. Indicator and cross-market strategy context continue to use the existing Coinbase Exchange candle/ticker feed; the entry gate is recalculated with the Advanced Trade spread and depth before a simulated entry. Shadow entries are subject to a one-position limit, symbol cooldown, daily trade cap, and daily/cumulative realized-loss guards.

- Shadow execution is simulation only: it never submits Coinbase orders and does not use account balances.
- The public Advanced Trade L2 snapshot does not reveal queue position, guaranteed fills, or the order book at the instant an order would actually arrive. Network latency and future book movement are not replayed. Stop/target monitoring is sampled on the scheduled scan and 10-second L2 refresh; brief crossings between samples can be missed.
- Open-position P&L is shown only when a fresh book has sufficient depth for a full modeled liquidation; otherwise it is unavailable rather than fabricated.
- The shadow fee and slippage settings are assumptions, not a guarantee of the account's actual fee tier or execution cost.
- Shadow results are forward-test evidence, not proof of future profitability. Review a sufficiently varied sample across market regimes before considering any separately authorized live test.

## Configuration

The Python service defaults to Coinbase USD products (BTC/USD, ETH/USD, SOL/USD). The Cloudflare Worker uses Coinbase public market data and Coinbase Advanced Trade for its separately guarded account connector. A Bitstamp legacy-position exit path remains isolated by the original paper-trade provider tag until those older positions are closed.

## Validation

Run `npm test`, `npm run check`, and `python -m pytest` before deployment. Passing CI alone does not prove that production is serving the intended revision. Verify `/api/health` for live market-feed/scheduler diagnostics, and verify `/api/worker/health` reports `status=ok`, `mode=paper_only`, `live_trading_enabled=false`, `deployment_provenance_status=verified`, and the intended `deployment_commit_sha`. Private dashboard and account diagnostics require owner authentication.
