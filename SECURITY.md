# Security and execution controls

- Coinbase is the only supported centralized exchange integration in this release.
- Public market-data access is read-only. Solana discovery is screening-only.
- Automatic strategy entries remain paper-only and cannot submit exchange orders.
- Coinbase Advanced Trade order execution is a separate, explicitly gated workflow. Keep it disabled until account permissions, product allowlists, fee estimates, balances, order limits, reconciliation and emergency controls have been verified.
- Store Coinbase API credentials only in private server/deployment secrets. Never commit secrets or send them through chat.
- Do not enable transfer or withdrawal permissions. Use least-privilege API keys.
- A passing test, backtest or paper fill does not guarantee profitability or live execution quality.
