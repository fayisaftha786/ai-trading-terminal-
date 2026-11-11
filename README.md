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

## Coinbase L2 Shadow Trading

The independent Shadow ledger is separate from the ordinary PAPER ledger and uses Coinbase Exchange public level-2 order-book snapshots only. It walks up to 25 visible bid/ask levels, records modeled VWAP, configured fees and an adverse slippage buffer, preserves partial fills, and estimates exits against fresh bid depth. Shadow entries are strategy-gated and subject to a one-position limit, symbol cooldown, daily trade cap, and daily/cumulative loss guards.

- Shadow execution is simulation only: it never submits Coinbase orders and does not use account balances.
- The public L2 snapshot does not reveal queue position, guaranteed fills, or the order book at the instant an order would actually arrive. Network latency and future book movement are not replayed. Stop/target monitoring is sampled on the scheduled scan and 10-second L2 refresh; brief crossings between samples can be missed.
- Open-position P&L is shown only when a fresh book has sufficient depth for a full modeled liquidation; otherwise it is unavailable rather than fabricated.
- The shadow fee and slippage settings are assumptions, not a guarantee of the account's actual fee tier or execution cost.
- Shadow results are forward-test evidence, not proof of future profitability. Review a sufficiently varied sample across market regimes before considering any separately authorized live test.

## Configuration

The Python service defaults to Coinbase USD products (BTC/USD, ETH/USD, SOL/USD). The Cloudflare Worker uses Coinbase public market data and Coinbase Advanced Trade for its separately guarded account connector. A Bitstamp legacy-position exit path remains isolated by the original paper-trade provider tag until those older positions are closed.

## Validation

Run npm test, npm run check, and python -m pytest before deployment. Deploy only after all checks pass and the live Worker is verified against the intended commit. This branch has not been deployed by this change.
