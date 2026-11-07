# Security policy and non-goals — v0.4.3

## Current boundary

- Production/live trading remains hard-disabled. `/api/live/execute` always returns HTTP 423.
- The automatic CEX strategy creates simulated paper positions only and is OFF after each backend restart.
- The app can read Binance Spot Testnet API credentials from the backend process environment only. No keys are returned by APIs and no browser credential fields exist.
- Explicitly enabling two local environment gates allows bounded, manual GTC LIMIT orders in Binance Spot Testnet. Strategy signals are not routed to that connector.
- Solana private keys and seed phrases are not accepted. No Solana signer or swap execution is included.

## Safe operating rules

- Run on localhost and the default single-worker process. Do not expose the server publicly without authentication, TLS, CSRF protection, request limits, multi-worker coordination, and a reviewed deployment architecture.
- Use only Binance Spot Testnet keys with minimum Spot read/trade permissions. Keep withdrawals disabled. Never use production keys in the sandbox.
- Keep secrets only in local `.env`; exclude it from Git, source archives and screenshots. Never paste credentials into chat or place them in source code, `.env.example`, browser storage or GitHub.
- Keep `BINANCE_TESTNET_ORDER_ENABLED=false` until you have verified the sandbox account and understand the manual LIMIT order workflow.
- Testnet assets are virtual and the environment may reset. A Testnet fill is not proof of live-market execution quality or profitability.
- The persistent Testnet emergency lock blocks new Testnet orders and attempts cancellation only for app-ledger orders. It cannot guarantee cancellation during exchange/network failure. Inspect Testnet order history, especially `UNKNOWN` orders, before resetting the lock.
- Invalid risk profiles block new entries. Exit/close actions remain available and use conservative fee/slippage caps if those specific persisted values are corrupt.
- Keep real funds separate. Never enter a wallet seed phrase or main-wallet private key into this application.
- Unknown order status and network timeouts are ambiguous. Reconcile before retrying; never create a new idempotency key simply to force a retry.
- Log decision/execution evidence without secrets.

## Report vulnerabilities

Do not submit private keys, seed phrases, passwords or API secrets in bug reports. Include reproducible steps with credentials fully redacted.
