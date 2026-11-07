from __future__ import annotations

import asyncio
import time
from datetime import datetime
from math import isfinite
from typing import Any

import httpx


BASE_URL = "https://api.exchange.coinbase.com"
MIN_PUBLIC_REQUEST_GAP_SECONDS = 1.0 / 3.0


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if isfinite(number) else None


def _timestamp_ms(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        number = _finite(value)
        return number * 1000 if number is not None else None
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return None
        return parsed.timestamp() * 1000
    except (TypeError, ValueError, OverflowError):
        return None


def product_for_symbol(symbol: str) -> tuple[str, str] | None:
    """Map configured USD/USDT spot symbols to Coinbase USD products."""
    if not isinstance(symbol, str) or "/" not in symbol:
        return None
    base, quote = symbol.strip().upper().split("/", 1)
    quote = quote.split(":", 1)[0]
    if not base.isalnum() or quote not in {"USD", "USDT", "USDC", "FDUSD"}:
        return None
    # Public Coinbase data is quoted in USD. USDT-family app symbols map to the
    # USD market only for read-only analysis; we do not pretend the basis is zero.
    if quote in {"USDT", "USDC", "FDUSD"}:
        quote = "USD"
    return base + "-" + quote, quote


def _depth_quote(levels: Any) -> float | None:
    if not isinstance(levels, list) or not levels:
        return None
    total = 0.0
    for level in levels[:10]:
        if not isinstance(level, (list, tuple)) or len(level) < 2:
            return None
        price, size = _finite(level[0]), _finite(level[1])
        if price is None or size is None or price <= 0 or size < 0:
            return None
        total += price * size
    return total if isfinite(total) else None


class CoinbasePublicAdapter:
    """Read-only Coinbase Exchange adapter with shared public-request pacing."""

    def __init__(
        self,
        *,
        client: httpx.AsyncClient | None = None,
        min_request_gap_seconds: float = MIN_PUBLIC_REQUEST_GAP_SECONDS,
    ):
        self._client = client or httpx.AsyncClient(
            base_url=BASE_URL,
            timeout=httpx.Timeout(12.0),
            headers={
                "Accept": "application/json",
                "User-Agent": "AI-Trading-Terminal-Public-Market-Data/1.0",
            },
        )
        self._owns_client = client is None
        self._min_gap = max(0.0, float(min_request_gap_seconds))
        self._request_lock = asyncio.Lock()
        self._last_request_at = 0.0

    async def __aenter__(self) -> "CoinbasePublicAdapter":
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def _get_json(self, path: str) -> Any:
        # Coinbase's published public REST limit is 3 requests/second. Keep one
        # serialized request stream shared across all concurrent symbol lookups.
        async with self._request_lock:
            wait = self._min_gap - (time.monotonic() - self._last_request_at)
            if wait > 0:
                await asyncio.sleep(wait)
            response = await self._client.get(path)
            self._last_request_at = time.monotonic()
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, (dict, list)):
            raise ValueError("Coinbase public API returned an unexpected JSON shape")
        return payload

    async def fetch_market(self, symbol: str) -> dict[str, Any]:
        mapped = product_for_symbol(symbol)
        if mapped is None:
            return {"symbol": symbol, "status": "unsupported", "error": "No Coinbase USD product mapping"}
        product_id, mapped_quote = mapped
        ticker, stats, book = await self._fetch_market_payloads(product_id)
        bid = _finite(ticker.get("bid"))
        ask = _finite(ticker.get("ask"))
        last = _finite(ticker.get("price"))
        base_volume = _finite(stats.get("volume"))
        quote_volume = base_volume * last if base_volume is not None and last is not None else None
        timestamp = _timestamp_ms(ticker.get("time"))
        retrieved_at = time.time() * 1000
        if bid is None or ask is None or last is None or min(bid, ask, last) <= 0 or ask < bid:
            return {
                "symbol": symbol,
                "status": "error",
                "error": "Coinbase returned an invalid or crossed top-of-book quote",
                "provider_symbol": product_id,
            }
        return {
            "symbol": symbol,
            "status": "live",
            "provider_symbol": product_id,
            "last": last,
            "bid": bid,
            "ask": ask,
            "quote_volume": quote_volume if quote_volume is not None and isfinite(quote_volume) else None,
            "percentage": None,
            "timestamp": timestamp,
            "bid_depth_quote": _depth_quote(book.get("bids")),
            "ask_depth_quote": _depth_quote(book.get("asks")),
            "orderbook_retrieved_at_ms": retrieved_at,
            "orderbook_timestamp_ms": None,
            "orderbook_timestamp_source": "retrieval_fallback",
            "quote_currency": mapped_quote,
            "quote_mapping": "USD market",
        }

    async def _fetch_market_payloads(self, product_id: str) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
        ticker = await self._get_json("/products/" + product_id + "/ticker")
        stats = await self._get_json("/products/" + product_id + "/stats")
        book = await self._get_json("/products/" + product_id + "/book?level=2")
        if not all(isinstance(item, dict) for item in (ticker, stats, book)):
            raise ValueError("Coinbase market response is not an object")
        return ticker, stats, book

    async def fetch_candles(self, symbol: str, granularity_seconds: int) -> list[list[float]]:
        mapped = product_for_symbol(symbol)
        if mapped is None:
            raise ValueError("No Coinbase USD product mapping for " + str(symbol))
        product_id, _ = mapped
        allowed = {60, 300, 900, 3600, 21600, 86400}
        if granularity_seconds not in allowed:
            raise ValueError("Coinbase public candles do not support this timeframe")
        rows = await self._get_json(
            "/products/" + product_id + "/candles?granularity=" + str(granularity_seconds)
        )
        if not isinstance(rows, list):
            raise ValueError("Coinbase candle response is not an array")
        result: list[list[float]] = []
        for row in rows:
            if not isinstance(row, (list, tuple)) or len(row) < 6:
                result.append(list(row) if isinstance(row, (list, tuple)) else [])
                continue
            # Coinbase format is [seconds, low, high, open, close, volume].
            converted: list[float] = []
            try:
                timestamp, low, high, opened, close, volume = map(float, row[:6])
                converted = [
                    timestamp * 1000,
                    opened,
                    high,
                    low,
                    close,
                    volume,
                ]
            except (TypeError, ValueError, OverflowError):
                converted = list(row[:6])
            result.append(converted)
        return result
