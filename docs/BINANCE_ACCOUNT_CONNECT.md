# Binance account connection — read-only stage

The app supports a separate production Binance Spot **read-only account check**. This is distinct from Binance Spot Testnet and does not enable real-money orders.

## Configure private server secrets

Set these environment variables only in the private backend's secret/environment settings:

```env
BINANCE_READONLY_ENABLED=true
BINANCE_READONLY_API_KEY=<your read-only API key>
BINANCE_READONLY_API_SECRET=<your API secret>
```

Keep the API key permission at **Enable Reading / USER_DATA only**. Do not enable Spot Trading, Margin, Futures, or withdrawals. If Binance requires IP restrictions for the permissions you select, follow Binance's current API Management guidance and restrict the key to the backend's fixed outbound IP. Never put the secret in the APK, browser, GitHub, source code, screenshots, or ChatGPT.

## Verify the connection

After deploying the updated backend, sign in to the private dashboard and call:

- `GET /api/binance/account/status`
- `POST /api/binance/account/connection-check`

The check reads the Spot account balance and returns non-zero asset names and USDT totals. It never returns API credentials. The backend must be running with `APP_ENV=production` and the configured authentication secrets; do not expose a development-mode service publicly.

## Isolated Binance Spot Testnet automatic strategy mode

The separate Testnet automation work is available only in the feature branch / draft PR until all dedicated tests and CI checks pass. It is disabled by default and must never be confused with the production read-only connector above.

For an isolated Testnet run, configure only **Binance Spot Testnet** credentials in the private backend environment:

```env
BINANCE_TESTNET_ENABLED=true
BINANCE_TESTNET_ORDER_ENABLED=true
BINANCE_TESTNET_API_KEY=<Testnet API key>
BINANCE_TESTNET_API_SECRET=<Testnet API secret>
BINANCE_TESTNET_MAX_ORDER_USDT=10
BINANCE_TESTNET_MAX_OPEN_ORDERS=3
```

Do not use production/live credentials in these Testnet variables. Keep the automatic-entry toggle OFF until the Testnet account connection is explicitly checked. The UI's “Enable Testnet auto” control then submits only fresh, allowlisted USDT BUY signals that pass the existing 1h/4h paper-strategy filters, liquidity checks, risk sizing, symbol cooldown and order caps. There is no automatic Solana DEX execution in this path.

Each proposed entry uses a limit FOK BUY inside a Binance Spot OTOCO list. Binance's OTOCO behavior places the pending TP/SL OCO legs only after the working order fully fills; therefore no fill means no position and no exit legs. The app reconciles the working order and each exit leg. Unknown or unprotected states block further auto entries. The emergency stop disables new entries, cancels unfilled app-owned order lists where safe, and preserves confirmed exchange-side TP/SL orders for filled entries. Stop-market exits can still slip in fast markets.

This is **Testnet execution plumbing, not proof of profitability**. The feature is not production live trading, does not guarantee profits, and must not be merged until dedicated OTOCO lifecycle/safety tests pass, latest backend and ARM64 CI pass, and actual Testnet behavior is manually verified. No API key or secret should be pasted into ChatGPT or committed to GitHub.

## What this does not do

- No production order placement, cancellation, transfer, withdrawal, margin, or futures methods exist in the read-only connector.
- `/api/live/execute` remains hard-locked.
- This connection check is not automatic trading. The existing strategy automation remains paper-only.
- Binance Spot Testnet is a separate virtual-money environment with its own credentials and explicit manual order gate.
- Do not enable live trading based on a short demo run. A production execution stage needs independent security review, exchange-side protection, reconciliation, risk caps, a kill switch, forward testing, and your explicit approval.

See [Binance's official Spot API security documentation](https://developers.binance.com/en/docs/products/spot/rest-api) and [API key setup guidance](https://www.binance.com/en/support/faq/detail/360002502072).
