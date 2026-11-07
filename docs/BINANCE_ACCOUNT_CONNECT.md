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

## What this does not do

- No production order placement, cancellation, transfer, withdrawal, margin, or futures methods exist in this connector.
- `/api/live/execute` remains hard-locked.
- This connection check is not automatic trading. The existing strategy automation remains paper-only.
- Binance Spot Testnet is a separate virtual-money environment with its own credentials and explicit manual order gate.
- Do not enable live trading based on a short demo run. A production execution stage needs independent security review, exchange-side protection, reconciliation, risk caps, a kill switch, forward testing, and your explicit approval.

See [Binance's official Spot API security documentation](https://developers.binance.com/en/docs/products/spot/rest-api) and [API key setup guidance](https://www.binance.com/en/support/faq/detail/360002502072).
