import asyncio

import httpx
import pytest

from app.services.coinbase_public import CoinbasePublicAdapter, product_for_symbol


def test_product_mapping_keeps_usd_and_maps_stablecoin_quote_to_usd():
    assert product_for_symbol("BTC/USDT") == ("BTC-USD", "USD")
    assert product_for_symbol("ETH/USD") == ("ETH-USD", "USD")
    assert product_for_symbol("SOL/USDC") == ("SOL-USD", "USD")
    assert product_for_symbol("BTC/BTC") is None
    assert product_for_symbol("BTCUSDT") is None


def test_fetch_market_normalizes_public_ticker_volume_and_depth():
    seen = []

    def handler(request):
        seen.append(request.url.path)
        if request.url.path.endswith("/ticker"):
            return httpx.Response(200, json={
                "trade_id": 123, "price": "100.5", "size": "0.2",
                "bid": "100.4", "ask": "100.6", "volume": "1",
                "time": "2026-11-07T12:00:00.123456Z"
            })
        if request.url.path.endswith("/stats"):
            return httpx.Response(200, json={
                "open": "99", "high": "102", "low": "98", "volume": "2500"
            })
        if request.url.path.endswith("/book"):
            return httpx.Response(200, json={
                "bids": [["100.4", "10", 1], ["100.3", "5", 1]],
                "asks": [["100.6", "8", 1], ["100.7", "4", 1]]
            })
        return httpx.Response(404)

    client = httpx.AsyncClient(
        base_url="https://api.exchange.coinbase.com",
        transport=httpx.MockTransport(handler),
    )
    adapter = CoinbasePublicAdapter(client=client, min_request_gap_seconds=0)
    try:
        result = asyncio.run(adapter.fetch_market("BTC/USDT"))
    finally:
        asyncio.run(client.aclose())

    assert result["status"] == "live"
    assert result["provider_symbol"] == "BTC-USD"
    assert result["last"] == 100.5
    assert result["bid"] == 100.4
    assert result["ask"] == 100.6
    assert result["quote_volume"] == 251250
    assert result["bid_depth_quote"] == pytest.approx(100.4 * 10 + 100.3 * 5)
    assert result["ask_depth_quote"] == pytest.approx(100.6 * 8 + 100.7 * 4)
    assert result["orderbook_timestamp_ms"] is None
    assert result["orderbook_timestamp_source"] == "retrieval_fallback"
    assert result["timestamp"] == pytest.approx(1794052800123.456)
    assert seen == [
        "/products/BTC-USD/ticker",
        "/products/BTC-USD/stats",
        "/products/BTC-USD/book"
    ]


def test_fetch_candles_converts_coinbase_ohlcv_to_standard_order():
    def handler(request):
        assert request.url.path == "/products/ETH-USD/candles"
        assert request.url.params["granularity"] == "3600"
        return httpx.Response(200, json=[
            [1794000000, "90", "110", "95", "105", "1234"]
        ])

    client = httpx.AsyncClient(
        base_url="https://api.exchange.coinbase.com",
        transport=httpx.MockTransport(handler),
    )
    adapter = CoinbasePublicAdapter(client=client, min_request_gap_seconds=0)
    try:
        rows = asyncio.run(adapter.fetch_candles("ETH/USDT", 3600))
    finally:
        await client.aclose()

    assert rows == [[1794000000000, 95.0, 110.0, 90.0, 105.0, 1234.0]]


def test_fetch_candles_rejects_unsupported_timeframe():
    client = httpx.AsyncClient(
        base_url="https://api.exchange.coinbase.com",
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=[])),
    )
    adapter = CoinbasePublicAdapter(client=client, min_request_gap_seconds=0)
    try:
        with pytest.raises(ValueError, match="do not support"):
            asyncio.run(adapter.fetch_candles("BTC/USDT", 14_400))
    finally:
        await client.aclose()


def test_public_http_errors_are_not_silently_treated_as_market_data():
    client = httpx.AsyncClient(
        base_url="https://api.exchange.coinbase.com",
        transport=httpx.MockTransport(lambda request: httpx.Response(451, json={"message": "Unavailable"})),
    )
    adapter = CoinbasePublicAdapter(client=client, min_request_gap_seconds=0)
    try:
        with pytest.raises(httpx.HTTPStatusError):
            asyncio.run(adapter.fetch_market("BTC/USDT"))
    finally:
        await client.aclose()
