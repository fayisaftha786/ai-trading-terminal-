# Coinbase public-data failover

The Python FastAPI backend continues to prefer the configured CCXT exchange. If CCXT is unavailable, the exchange ID is unsupported, all configured markets fail, or OHLCV retrieval throws, the read-only Coinbase Exchange REST adapter is attempted.

## Data path

- Ticker, 24-hour stats and level-2 order book are fetched for configured spot symbols.
- BTC/USDT, ETH/USDT and SOL/USDT map to Coinbase BTC-USD, ETH-USD and SOL-USD public products. The displayed/ledger symbol remains the configured app symbol; the quote mapping is disclosed as USD and is not a USDT basis conversion.
- 5m and 15m manual research, plus the 1h automatic strategy path, use exact Coinbase-supported candle intervals. The 1h primary strategy uses 6h confirmation; bars are never fabricated or resampled into 4h candles.
- The adapter paces shared public requests at no more than three requests per second, consistent with Coinbase's published public REST limit.
- Coinbase book responses do not supply a trustworthy exchange event timestamp through this REST path. The adapter records local retrieval time as weaker provenance, and the existing 15-second freshness/depth/spread gates still apply.
- The adapter is read-only. It has no order endpoint, wallet functionality or exchange credentials.

## Fail-closed behavior

If any endpoint fails, quote timestamps are missing/stale, candle history is incomplete, OHLCV rows are malformed, top-of-book depth is absent, spread exceeds the current limit, volume is too low, indicators do not qualify, or the 1h/6h regimes are not aligned, the strategy returns HOLD/no entry. If Coinbase is also unavailable from the user's cloud region, the backend remains without live CEX markets. Do not bypass HTTP 451 or other exchange regional restrictions through proxies or VPNs.

## Execution and limitations

The existing application remains PAPER-only by default. Automatic entries still require a deliberate user opt-in, and the existing risk profile, daily cap, cooldown, position sizing and drawdown controls still apply. The 1h strategy uses 6h confirmation when Coinbase fallback is active; the actual interval is now passed to the candle-freshness gate and shown in scan output.

This does not enable Binance production orders or Binance Spot Testnet. It does not promise profitability. Coinbase USD markets are not the same instrument as USDT markets, so the mapping has a small stablecoin basis risk that is not automatically hedged or converted.
