# AI Trading Terminal

Coinbase-only crypto market research and paper-trading platform with a Cloudflare Durable Object engine and an Android-friendly dashboard.

## Exchange scope

- Coinbase is the only supported centralized exchange provider. Public ticker, order-book and candle research use Coinbase endpoints.
- Binance integrations, Binance Spot Testnet, Binance credentials, Binance market-data endpoints and Binance-specific dashboard controls have been removed from this branch.
- Solana token discovery through Jupiter is research and screening only; it does not submit swaps.
- Coinbase Advanced Trade account connectivity and guarded order workflows remain separate features. They require explicit owner configuration, fresh preflight checks, bounded limits and confirmation.

## Execution safety

- Automatic strategy execution remains PAPER-only. Paper automation never sends exchange orders.
- Real Coinbase order execution remains locked unless the separate Coinbase Advanced Trade authorization and server-side safeguards are deliberately configured.
- No profitability or future-return guarantee is made. Backtests and paper results are not evidence of future profits.
- Keep API credentials in private deployment secrets. Never commit keys or paste them into chat.

## Configuration

The Python service defaults to Coinbase USD products (BTC/USD, ETH/USD, SOL/USD). The Cloudflare Worker uses Coinbase public market data and Coinbase Advanced Trade for its separately guarded account connector. Remove obsolete Binance secrets from your deployment environment after reviewing any external services that may still reference them.

## Validation

Run npm test, npm run check, and python -m pytest before deployment. Deploy only after all checks pass and the live Worker is verified against the intended commit. This branch has not been deployed by this change.
