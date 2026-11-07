# Binance Spot Testnet setup — v0.3.9

This build adds an optional, separately gated **manual LIMIT-order workflow** for Binance Spot Testnet. It remains isolated from production. Strategy-driven Testnet automation, OCO/stop-loss exchange orders, and live trading are not enabled.

## 1. Create sandbox credentials

1. Open the official [Binance Spot Test Network](https://testnet.binance.vision/) and create a Testnet API key. Use only sandbox credentials; production keys are not interchangeable with sandbox keys.
2. In API permissions, enable only the permissions needed for spot account reading and spot trading. Keep withdrawals disabled. Never paste credentials into ChatGPT, source files, screenshots, or GitHub.
3. Testnet funds are virtual. The environment can reset, and a Testnet run does not establish profitable or safe production execution.

## 2. Configure locally

Copy `.env.example` to `.env` on your own device, then set: 

```env
BINANCE_TESTNET_ENABLED=true
BINANCE_TESTNET_API_KEY=YOUR_TESTNET_KEY
BINANCE_TESTNET_API_SECRET=YOUR_TESTNET_SECRET
BINANCE_TESTNET_ORDER_ENABLED=false
BINANCE_TESTNET_MAX_ORDER_USDT=10
BINANCE_TESTNET_MAX_OPEN_ORDERS=3
```

Start with `BINANCE_TESTNET_ORDER_ENABLED=false`. Restart the local app and use **Check Testnet connection**. This verifies signed account access; it does not submit an order.

Only after confirming the account and understanding the order form, explicitly set `BINANCE_TESTNET_ORDER_ENABLED=true` locally and restart. Credentials are never sent to the browser.

## 3. What the Testnet order UI can do

- Submit only explicit **LIMIT / GTC** BUY or SELL orders. There is no market-order route.
- Restrict markets to `CEX_SYMBOLS` configured locally and USDT quote markets only.
- Apply exchange amount/price precision, minimum amount/cost, free-balance checks, a per-order USDT notional cap, and a maximum count of open/unresolved app orders.
- Generate a stable client order ID from an idempotency key and persist a local order journal before the exchange call. Repeated submissions with the same key do not create a second exchange order.
- Refresh known order state, reconcile an ambiguous submission by searching recent order history for its client ID, and cancel known open or partially filled orders.
- If the request times out after submission may have reached Binance, record `UNKNOWN`, block blind resubmission, and require reconciliation. A missing order in one history query is not treated as proof that no order was accepted.
- Emergency lock persists in SQLite across restart. It cancels only app-ledger orders it can identify; unresolved orders remain visibly unresolved. Check the official Testnet order history yourself before attempting to reset the lock.

## 4. Safety limits and current gaps

- Default cap is 10 USDT per order and at most 3 open/unresolved Testnet orders. Adjust only in the local `.env` file after you understand the effect.
- The workflow is **manual Testnet order submission**, not strategy-driven automatic trading. The existing automatic strategy remains paper-only.
- No exchange-native OCO, stop-loss, take-profit, trailing-stop or automatic position exit is connected yet. A GTC limit order may remain open until filled or canceled.
- Testnet orders are not converted into paper positions or used in the paper P&L report.
- The app's local ledger can be incomplete if the device/database is lost. Always inspect exchange-side order history.
- For the 0.5.0 Cloud Edition, deploy only through the HTTPS-protected private cloud setup in `CLOUD_DEPLOYMENT_NO_TERMUX_MALAYALAM.md`. Production API routes require a bearer token after dashboard password login. Keep the Render service single-instance with one worker while SQLite is used.
- Never expose a development-mode backend (`APP_ENV=development`) to the public internet. Development mode intentionally does not require authentication.
- Testnet credentials must be added only through the hosting provider's protected environment settings, never in the APK or repository. Keep both Testnet switches OFF until a separate sandbox verification is complete.
- `/api/live/execute` remains hard-locked with HTTP 423. This build does not enable real-money orders.

## 5. API endpoints

- `GET /api/testnet/status` — connection/order gate state (never returns keys).
- `POST /api/testnet/connection-check` — authenticated balance read.
- `GET /api/testnet/orders` — local Testnet order ledger.
- `POST /api/testnet/orders` — bounded Testnet LIMIT order (requires both environment gates and valid credentials).
- `POST /api/testnet/orders/{client_order_id}/refresh` — refresh or reconcile order.
- `POST /api/testnet/orders/{client_order_id}/cancel` — cancel a known open order.
- `POST /api/testnet/kill-switch` — persist emergency lock and attempt to cancel app-owned open orders.
- `POST /api/testnet/kill-switch/reset` — explicit reset only when no open/unresolved ledger orders remain.

CCXT sandbox mode is activated immediately after exchange construction, before other exchange calls. See the [CCXT sandbox guidance](https://docs.ccxt.com/docs/manual#testnets-and-sandbox-environments) and [Binance Spot Testnet documentation](https://github.com/binance/binance-spot-api-docs/tree/master/testnet).
