# Architecture notes

## Components

```text
Jupiter Tokens API v2 (read-only) ─┐
                                  ├─ MarketDataService ─ token discovery / public CEX data
Coinbase public REST endpoints (read-only) ┘                         │
                                                            ▼
                                 Raw OHLCV integrity gate (malformed / duplicate / off-grid / missing)
                                                            │
                                                            ▼
                           Deterministic analysis (EMA / Wilder RSI-ATR-ADX / DI / volume / breakout / regime)
                                                            │
                                                            ▼
                     Strategy-aligned replay + walk-forward (saved risk / fees / benchmark / cost stress)
                                                            │
                                                            ▼
                                       Independent risk manager / automatic paper controller
                                                            │
                                                            ▼
                                                    PaperBroker
                                                            │
                                                            ▼
                                                  SQLite ledger + events
                                                            │
                                                            ▼
                                                    FastAPI dashboard
```

## Separation of duties

- Market data adapters are read-only.
- Strategy analysis returns evidence (indicators, scores and reasons), not transactions. The score is an uncalibrated rule score, not a probability.
- Raw candle integrity is evaluated before analysis/research; duplicate, malformed, off-grid or missing intervals block candidate decisions and historical replay.
- Strategy replay/walk-forward reads the saved server-side risk and cost profile; the caller cannot submit alternative fee or risk assumptions to make a configuration appear better.
- The risk manager decides whether a requested paper position fits configured exposure and loss budgets.
- The paper broker is the only execution implementation in this version. Backtest signals use prior-close decisions and next-candle-open fills with explicit fee/slippage assumptions.
- The production live route is a hard denial. No exchange sandbox or automatic live-order connector is used by the automatic strategy. No Solana wallet signing or swap executor is included.

## Solana future-live design gate

A future swap executor must use the current Jupiter Swap API V2 contract and a separately audited signer. The server should obtain a quote/order, decode and validate all account/program/mint/amount/fee fields against policy, simulate where supported, request a signature from a dedicated signer, submit using the current route-specific Jupiter flow, then verify the final signature and actual token/account deltas. It must handle blockhash expiry and ambiguous submission states by querying the signature before retrying.

## CEX future-live design gate

A future exchange adapter must be specific to one approved exchange, use read/trade-only keys with withdrawals disabled and IP restrictions, enforce exchange filters and minimum order sizes, use client order IDs/idempotency where supported, reconcile fills and fees from private trade/account streams, and fail closed on stale data, clock drift, rate limits, or unknown order state.

## Required live-release evidence

- Eligibility review for the user's jurisdiction and the specific exchange/provider.
- Security review and threat model for the signer and secrets path.
- Unit, contract, integration, chaos and duplicate-submit tests.
- Forward paper evidence under realistic fees/slippage and separate strategy validation.
- Balance reconciliation with zero unexplained deltas.
- Independent emergency stop and spend cap.
- Small controlled live pilot only after all gates pass.
