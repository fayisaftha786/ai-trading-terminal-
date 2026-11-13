# Release status

## Production verification

- The dashboard/workforce update in PR #158 was first deployed successfully at commit `050316677968ac0cf4062a5b34da3e5e3ce8bb35`.
- The follow-up documentation-only PR #159 was also deployed successfully at commit `88d3dd53d5038424d854d8bd36ca147fa5a29bba`; it changed release documentation only, not market analysis, trading, automation, or execution behavior.
- The exact current Worker commit, version ID and provenance are intentionally read from the live `/api/worker/health` endpoint. Documentation-only merges can trigger a new deployment revision, so a fixed SHA in this file would become stale.
- The live health contract must report `status=ok`, `mode=paper_only`, `live_trading_enabled=false`, and `deployment_provenance_status=verified`.
- The matching deployment, complete unit tests, Worker dry-run build, production PAPER-only verification, post-deploy stability check, and free cloud market scanner workflows completed successfully for the verified releases.

## Exchange scope

- Coinbase Exchange is the public market-data provider for normal scans and all new PAPER entries.
- Coinbase Advanced Trade is the separately gated account/order connector.
- Binance account, market-strategy and radar modules, Binance setup documentation, and their dedicated tests were removed from the deployed `main` line.
- A narrow Bitstamp read-only compatibility path may remain solely to mark or close an already-open legacy PAPER position originally created from Bitstamp data. It cannot create new entries or affect the Coinbase BTC-led market context.

## Execution safety

- Automatic strategy execution remains PAPER-only. New installations default to automatic PAPER entries disabled; enabling them requires an authenticated owner action and a recent complete healthy scan.
- The private automation setting and authenticated Coinbase account preflight are not exposed by public health endpoints; they must be checked from an authenticated dashboard session.
- Live Coinbase order execution remains locked unless the separate owner-controlled authorization and server-side safeguards are deliberately configured. Public production health must continue to report `live_trading_enabled=false`.
- Workforce specialists are deterministic, read-only analysis roles. They cannot authorize or submit exchange orders.
- Research tournament results are offline research only, are not a backtest of the production PAPER engine, and must not be presented as expected returns or a profitability guarantee.
