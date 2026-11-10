from __future__ import annotations

import asyncio
import time
from math import isfinite
from typing import Any

import httpx

from app.settings import Settings
from app.services.coinbase_public import CoinbasePublicAdapter, product_for_symbol


class MarketDataService:
    """Read-only public market-data adapters. No order endpoints are used here."""

    def __init__(self, config: Settings):
        self.config = config
        self._cache: dict[str, tuple[float, Any]] = {}

    def _get_cache(self, key: str) -> Any | None:
        cached = self._cache.get(key)
        if cached and time.monotonic() - cached[0] < self.config.market_cache_seconds:
            return cached[1]
        return None

    def _put_cache(self, key: str, value: Any) -> None:
        self._cache[key] = (time.monotonic(), value)

    def _get_cache_ttl(self, key: str, ttl_seconds: float) -> Any | None:
        cached = self._cache.get(key)
        if cached and time.monotonic() - cached[0] < max(0.0, ttl_seconds):
            return cached[1]
        return None

    async def _coinbase_tickers(self, cache_key: str, fallback_reason: str) -> dict[str, Any]:
        try:
            async with CoinbasePublicAdapter() as provider:
                results = await asyncio.gather(
                    *(provider.fetch_market(symbol) for symbol in self.config.cex_symbols),
                    return_exceptions=True,
                )
            markets: list[dict[str, Any]] = []
            for symbol, result in zip(self.config.cex_symbols, results):
                if isinstance(result, BaseException):
                    markets.append({
                        "symbol": symbol,
                        "status": "error",
                        "market_data_provider": "coinbase_public_fallback",
                        "error": str(result)[:180],
                    })
                else:
                    markets.append({
                        **result,
                        "market_data_provider": "coinbase_public_fallback",
                        "quote_currency": "USD",
                    })
            response = {
                "status": "live" if any(row.get("status") == "live" for row in markets) else "error",
                "exchange": "coinbase_public_fallback",
                "provider": "Coinbase Exchange public REST",
                "fallback_reason": fallback_reason[:200],
                "markets": markets,
            }
            self._put_cache(cache_key, response)
            return response
        except Exception as exc:
            return {
                "status": "error",
                "exchange": "coinbase_public_fallback",
                "provider": "Coinbase Exchange public REST",
                "fallback_reason": fallback_reason[:160],
                "error": str(exc)[:200],
                "markets": [],
            }

    async def _coinbase_strategy_data(
        self, symbol: str, timeframe: str, limit: int, fallback_reason: str
    ) -> dict[str, Any]:
        cache_key = f"coinbase_strategy:{symbol}:{timeframe}"
        cached = self._get_cache_ttl(cache_key, 300.0)
        if cached is not None:
            return cached

        from app.services.strategy import analyze_candles, candle_integrity_report

        # These are exact Coinbase-supported intervals, not resampled or relabelled bars.
        timeframe_map = {
            "5m": (300_000, 300, "1h", 3_600_000, 3600),
            "15m": (900_000, 900, "6h", 21_600_000, 21600),
            "1h": (3_600_000, 3600, "6h", 21_600_000, 21600),
        }
        if timeframe not in timeframe_map:
            return {
                "status": "unavailable",
                "symbol": symbol,
                "error": "Coinbase fallback supports exact 5m, 15m and 1h primary candles only",
                "fallback_reason": fallback_reason[:160],
                "candles": [],
            }
        timeframe_ms, primary_seconds, confirm_timeframe, confirm_ms, confirm_seconds = timeframe_map[timeframe]
        mapped_product = product_for_symbol(symbol)
        provider_symbol = mapped_product[0] if mapped_product else None
        quote_currency = mapped_product[1] if mapped_product else None
        try:
            async with CoinbasePublicAdapter() as provider:
                primary_raw, higher_raw = await asyncio.gather(
                    provider.fetch_candles(symbol, primary_seconds),
                    provider.fetch_candles(symbol, confirm_seconds),
                )
            now_ms = time.time() * 1000

            def closed_rows(raw_rows: list[Any], interval_ms: int) -> list[list[float]]:
                closed: list[list[float]] = []
                for row in raw_rows:
                    if not isinstance(row, (list, tuple)) or len(row) < 6:
                        closed.append(list(row) if isinstance(row, (list, tuple)) else [])
                        continue
                    try:
                        timestamp = float(row[0])
                        if not isfinite(timestamp) or timestamp + interval_ms <= now_ms:
                            closed.append(list(row))
                    except (TypeError, ValueError, OverflowError):
                        closed.append(list(row))
                return closed

            primary = closed_rows(primary_raw, timeframe_ms)
            higher = closed_rows(higher_raw, confirm_ms)
            primary_quality = candle_integrity_report(primary, timeframe_ms)
            higher_quality = candle_integrity_report(higher, confirm_ms)
            primary_clean = bool(primary_quality["is_clean"])
            higher_clean = bool(higher_quality["is_clean"])
            analysis = analyze_candles(primary, bars_per_day=86_400_000 / timeframe_ms)
            higher_analysis = analyze_candles(higher, bars_per_day=86_400_000 / confirm_ms)
            if not primary_clean or not higher_clean:
                message = "Missing or off-grid closed candle intervals; signal and backtest are blocked"
                for item in (analysis, higher_analysis):
                    item["signal"] = "HOLD"
                    item["score"] = 0
                    item["regime"] = "DATA_GAP"
                    item["reason"] = message
                    item.setdefault("reasons", []).append(message)
            aligned = (
                analysis.get("regime") == higher_analysis.get("regime")
                and analysis.get("regime") in {"UPTREND", "DOWNTREND"}
            )
            response = {
                "status": "live",
                "symbol": symbol,
                "timeframe": timeframe,
                "higher_timeframe": {
                    "timeframe": confirm_timeframe,
                    "analysis": higher_analysis,
                    "candles": higher,
                },
                "analysis": analysis,
                "timeframe_confluence": "ALIGNED" if aligned else "MIXED_OR_UNCONFIRMED",
                "candles": primary,
                "last_closed_candle_timestamp_ms": primary[-1][0] if primary else None,
                "higher_timeframe_last_closed_candle_timestamp_ms": higher[-1][0] if higher else None,
                "higher_timeframe_interval_ms": confirm_ms,
                "provider": "coinbase_public_fallback",
                "provider_symbol": provider_symbol,
                "quote_currency": quote_currency,
                "fallback_reason": fallback_reason[:160],
                "data_quality": {
                    "primary_missing_intervals": primary_quality["missing_intervals"] + primary_quality["off_interval_pairs"],
                    "higher_timeframe_missing_intervals": higher_quality["missing_intervals"] + higher_quality["off_interval_pairs"],
                    "primary_integrity": primary_quality,
                    "higher_timeframe_integrity": higher_quality,
                    "primary_valid_candles": primary_quality["valid_unique_candles"],
                    "higher_timeframe_valid_candles": higher_quality["valid_unique_candles"],
                    "contiguous_closed_candles": bool(primary and higher) and primary_clean and higher_clean,
                    "sufficient_indicator_history": (
                        primary_quality["valid_unique_candles"] >= 150
                        and higher_quality["valid_unique_candles"] >= 150
                    ),
                },
            }
            self._put_cache(cache_key, response)
            return response
        except Exception as exc:
            return {
                "status": "error",
                "symbol": symbol,
                "provider": "coinbase_public_fallback",
                "fallback_reason": fallback_reason[:160],
                "error": str(exc)[:200],
                "candles": [],
            }

    async def cex_tickers(self) -> dict[str, Any]:
        cache_key = "cex_tickers"
        cached = self._get_cache(cache_key)
        if cached is not None:
            return cached
        return await self._coinbase_tickers(cache_key, "Coinbase-only market data configuration")

    async def cex_strategy_data(self, symbol: str, timeframe: str = "1h", limit: int = 300) -> dict[str, Any]:
        """Fetch Coinbase-native closed candles and multi-timeframe analysis."""
        return await self._coinbase_strategy_data(
            symbol, timeframe, limit, "Coinbase-only market data configuration"
        )

    async def solana_recent_tokens(self) -> dict[str, Any]:
        cache_key = "solana_recent"
        cached = self._get_cache(cache_key)
        if cached is not None:
            return cached
        headers = {"accept": "application/json"}
        if self.config.jupiter_api_key:
            headers["x-api-key"] = self.config.jupiter_api_key
        url = f"{self.config.jupiter_base_url.rstrip('/')}/recent"
        try:
            async with httpx.AsyncClient(timeout=12.0, headers=headers) as client:
                response = await client.get(url)
                response.raise_for_status()
                payload = response.json()
            items = payload if isinstance(payload, list) else payload.get("tokens", []) if isinstance(payload, dict) else []
            tokens = [self._normalize_token(item) for item in items if isinstance(item, dict)]
            tokens = [item for item in tokens if item.get("mint")]
            result = {"status": "live", "provider": "Jupiter Tokens API v2", "tokens": tokens[:50]}
            self._put_cache(cache_key, result)
            return result
        except Exception as exc:
            return {"status": "error", "provider": "Jupiter Tokens API v2", "error": str(exc)[:240], "tokens": []}

    @staticmethod
    def _normalize_token(item: dict[str, Any]) -> dict[str, Any]:
        audit = item.get("audit") if isinstance(item.get("audit"), dict) else {}
        return {
            "mint": item.get("id") or item.get("mint") or "",
            "name": item.get("name") or "Unknown token",
            "symbol": item.get("symbol") or "?",
            "price_usd": _number(item.get("usdPrice")),
            "liquidity_usd": _number(item.get("liquidity")),
            "market_cap_usd": _number(item.get("mcap")),
            "holders": _number(item.get("holderCount")),
            "organic_score": _number(item.get("organicScore")),
            "verified": bool(item.get("isVerified", False)),
            "banned": bool(item.get("isBanned", False)) or str(item.get("verification", "")).lower() == "banned"
                      or "banned" in [str(tag).lower() for tag in (item.get("tags") or [])],
            "is_sus": bool(item.get("isSus", audit.get("isSus", False))),
            "mint_authority_disabled": audit.get("mintAuthorityDisabled"),
            "freeze_authority_disabled": audit.get("freezeAuthorityDisabled"),
            "top_holders_percentage": _number(audit.get("topHoldersPercentage")),
            "source": "jupiter_tokens_v2",
        }


def _number(value: Any) -> float | None:
    try:
        if value is None:
            return None
        number = float(value)
        return number if isfinite(number) else None
    except (TypeError, ValueError, OverflowError):
        return None
