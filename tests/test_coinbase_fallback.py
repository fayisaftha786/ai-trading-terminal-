import time
from dataclasses import replace

import pytest

from app.services.market_data import MarketDataService
from app.settings import settings


class FakeCoinbaseAdapter:
    def __init__(self, **_kwargs):
        self.requested = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return None

    async def fetch_market(self, symbol):
        return {
            "symbol": symbol,
            "status": "live",
            "last": 100.0,
            "bid": 99.99,
            "ask": 100.01,
            "quote_volume": 2_000_000.0,
            "timestamp": time.time() * 1000,
            "bid_depth_quote": 100_000.0,
            "ask_depth_quote": 100_000.0,
            "orderbook_retrieved_at_ms": time.time() * 1000,
            "orderbook_timestamp_ms": None,
            "orderbook_timestamp_source": "retrieval_fallback",
        }

    async def fetch_candles(self, symbol, granularity_seconds):
        interval = granularity_seconds * 1000
        now_ms = int(time.time() * 1000)
        last_open = (now_ms // interval) * interval - interval
        count = 160
        start = last_open - ((count - 1) * interval)
        rows = []
        for index in range(count):
            close = 100.0 + index * 0.1
            rows.append([start + index * interval, close - 0.1, close + 0.4, close - 0.4, close, 1000.0])
        return rows


@pytest.mark.asyncio
async def test_tickers_fall_back_to_coinbase_if_ccxt_import_is_unavailable(monkeypatch):
    import builtins
    import app.services.market_data as market_data_module

    original_import = builtins.__import__

    def blocked_ccxt_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "ccxt.async_support":
            raise ImportError("simulated missing CCXT dependency")
        return original_import(name, globals, locals, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", blocked_ccxt_import)
    monkeypatch.setattr(market_data_module, "CoinbasePublicAdapter", FakeCoinbaseAdapter)
    config = replace(settings, cex_symbols=("BTC/USDT", "ETH/USDT", "SOL/USDT"))
    service = MarketDataService(config)

    result = await service.cex_tickers()

    assert result["status"] == "live"
    assert result["exchange"] == "coinbase_public_fallback"
    assert len(result["markets"]) == 3
    assert all(row["status"] == "live" for row in result["markets"])
    assert all(row["orderbook_timestamp_source"] == "retrieval_fallback" for row in result["markets"])


@pytest.mark.asyncio
async def test_coinbase_ohlcv_fallback_uses_exact_six_hour_confirmation(monkeypatch):
    import app.services.market_data as market_data_module

    monkeypatch.setattr(market_data_module, "CoinbasePublicAdapter", FakeCoinbaseAdapter)
    config = replace(settings, cex_symbols=("BTC/USDT",))
    service = MarketDataService(config)

    result = await service._coinbase_strategy_data(
        "BTC/USDT", "1h", 300, "simulated Binance HTTP 451"
    )

    assert result["status"] == "live"
    assert result["provider"] == "coinbase_public_fallback"
    assert result["higher_timeframe"]["timeframe"] == "6h"
    assert result["higher_timeframe_interval_ms"] == 6 * 3_600_000
    assert result["data_quality"]["contiguous_closed_candles"] is True
    assert result["data_quality"]["sufficient_indicator_history"] is True
    assert len(result["candles"]) == 160
    assert len(result["higher_timeframe"]["candles"]) == 160


@pytest.mark.asyncio
async def test_coinbase_fallback_does_not_fabricate_unsupported_primary_timeframe(monkeypatch):
    import app.services.market_data as market_data_module

    monkeypatch.setattr(market_data_module, "CoinbasePublicAdapter", FakeCoinbaseAdapter)
    config = replace(settings, cex_symbols=("BTC/USDT",))
    service = MarketDataService(config)

    result = await service._coinbase_strategy_data(
        "BTC/USDT", "4h", 300, "simulated Binance HTTP 451"
    )

    assert result["status"] == "unavailable"
    assert "exact 5m, 15m and 1h" in result["error"]
    assert result["candles"] == []
