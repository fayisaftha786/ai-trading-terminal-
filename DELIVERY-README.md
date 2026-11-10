# Delivery notes

- The application is being consolidated to Coinbase-only centralized-exchange market data and account integration.
- Binance Spot Testnet, Binance account access, Binance market scanner and Binance-specific UI have been removed from the cleanup branch.
- Automatic trading remains paper-only; Coinbase live order execution remains separately gated and locked by default.
- Run the JavaScript and Python test suites and verify the deployment revision before production rollout.
