# Technical sources checked for this implementation

- CCXT manual: https://docs.ccxt.com/docs/manual
  - Unified exchange interface, supported exchanges, rate limits and public/private API separation.
- Jupiter Solana Token API V2: https://developers.jup.ag/docs/tokens
  - `/recent`, token mint identity, verification, Organic Score, liquidity, holders and audit fields including mint/freeze authority-disabled flags and top-holder percentage.
- Jupiter Swap API V2: https://developers.jup.ag/docs/swap
  - Current order/execute and build/submit integration paths for future transaction execution.
- Solana signing in production: https://solana.com/docs/core/transactions/signing-in-production
  - Do not place private keys in frontend code or source control; production signer choices.
- Solana transaction confirmation and expiration: https://solana.com/developers/cookbook/transactions/confirmation
  - Recent blockhash, simulation, submit, confirmation and expiry behavior.
- Binance developer documentation: https://developers.binance.com/en/docs/introduction
  - Official product-specific API references; provider eligibility and regional access must be separately checked.
- FIU-IND: https://fiuindia.gov.in/
  - Current AML/CFT guidance and provider-status context for India; a FIU registration should not be represented as a government guarantee or investment endorsement.
