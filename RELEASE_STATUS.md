# Release status

## Verified production release

- Production Cloudflare Worker is deployed from `main` at commit `050316677968ac0cf4062a5b34da3e5e3ce8bb35` (2026-11-13).
- `/api/worker/health` reports `status=ok`, `mode=paper_only`, `live_trading_enabled=false`, and `deployment_provenance_status=verified` for that exact commit.
- The production Worker version is `62a365b7-9e77-43b8-81da-d17c042c4679`.
- The matching deployment, Cloudflare paper-engine validation, and free cloud market-scanner workflows completed successfully.
- The public runtime health check reports a healthy scheduler and fresh Coinbase market data for BTC/USD, ETH/USD and SOL/USD. Entry decisions remain governed by the full market-regime, quote, order-book, spread, depth, portfolio and risk gates.

## Exchange scope

- Coinbase Exchange is the public market-data provider for normal scans and all new PAPER entries.
- Coinbase Advanced Trade is the separately gated account/order connector.
- Binance account, market-strategy and radar modules, Binance setup documentation, and their dedicated tests were removed from the deployed `main` line.
- A narrow Bitstamp read-only compatibility path may remain solely to mark or close an already-open legacy PAPER position originally created from Bitstamp data. It cannot create new entries or affect the Coinbase BTC-led market context.

## Execution safety

- Automatic strategy execution remains PAPER-only. New installations default to automatic PAPER entries disabled; enabling them requires an authenticated owner action and a recent complete healthy scan.
- The private automation setting and authenticated Coinbase account preflight are not exposed by public health endpoints; they must be checked from an authenticated dashboard session.
- Live Coinbase order execution remains locked unless the separate owner-controlled authorization and server-side safeguards are deliberately configured. Public production health currently confirms `live_trading_enabled=false`.
- Workforce specialists are deterministic, read-only analysis roles. They cannot authorize or submit exchange orders.
- Research tournament results are offline research only, are not a backtest of the production PAPER engine, and must not be presented as expected returns or a profitability guarantee.
