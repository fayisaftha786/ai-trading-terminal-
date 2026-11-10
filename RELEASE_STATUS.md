# Release status

The Coinbase-only cleanup is maintained on the remove-binance-coinbase-only branch. It is not considered released or deployed until CI passes and the production Worker reports the expected commit/version.

Automatic strategy execution remains paper-only. Coinbase Advanced Trade is the only exchange account/order connector and remains separately gated; no live order execution is enabled by this cleanup.
