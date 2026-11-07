from __future__ import annotations

from math import isfinite
from typing import Any


class BinanceAccountUnavailable(RuntimeError):
    """Raised when the optional production Binance read-only connector is unavailable."""


class BinanceSpotReadOnly:
    """Production Binance Spot account reader. This class deliberately has no order methods."""

    def __init__(self, config: Any, exchange_factory: Any | None = None):
        self.config = config
        self._exchange_factory = exchange_factory

    def status(self) -> dict[str, Any]:
        configured = bool(
            self.config.binance_readonly_api_key
            and self.config.binance_readonly_api_secret
        )
        enabled = bool(self.config.binance_readonly_enabled)
        return {
            "provider": "Binance Spot",
            "environment": "production_read_only",
            "enabled": enabled,
            "credentials_configured": configured,
            "ready_for_connection_check": enabled and configured,
            "permissions_required": ["Enable Reading / USER_DATA"],
            "trade_permission_required": False,
            "withdrawal_permission_required": False,
            "order_execution_available": False,
            "live_trading_enabled": False,
        }

    def check_account(self) -> dict[str, Any]:
        state = self.status()
        if not state["enabled"]:
            raise BinanceAccountUnavailable(
                "Binance production account reader is disabled. Set BINANCE_READONLY_ENABLED=true."
            )
        if not state["credentials_configured"]:
            raise BinanceAccountUnavailable(
                "Binance read-only API credentials are missing. Configure them in private server secrets."
            )
        exchange = None
        try:
            params = {
                "apiKey": self.config.binance_readonly_api_key,
                "secret": self.config.binance_readonly_api_secret,
                "enableRateLimit": True,
                "timeout": 15000,
                "options": {"defaultType": "spot"},
            }
            if self._exchange_factory is not None:
                exchange = self._exchange_factory(params)
            else:
                import ccxt  # type: ignore[import-not-found]
                exchange = ccxt.binance(params)
            balance = exchange.fetch_balance()
            free = balance.get("free") or {}
            used = balance.get("used") or {}
            total = balance.get("total") or {}
            assets = sorted(
                str(asset) for asset, amount in total.items()
                if self._positive(amount)
            )
            return {
                "connected": True,
                "provider": "Binance Spot",
                "environment": "production_read_only",
                "available_assets": assets,
                "asset_count": len(assets),
                "usdt_free": self._safe_float(free.get("USDT")),
                "usdt_used": self._safe_float(used.get("USDT")),
                "usdt_total": self._safe_float(total.get("USDT")),
                "trade_permission_required": False,
                "withdrawal_permission_required": False,
                "order_execution_available": False,
                "live_trading_enabled": False,
            }
        except BinanceAccountUnavailable:
            raise
        except Exception as exc:
            # Provider messages can echo request details. Never return raw exception text.
            raise BinanceAccountUnavailable(
                f"Binance read-only account check failed: {type(exc).__name__}"
            ) from None
        finally:
            if exchange is not None:
                try:
                    exchange.close()
                except Exception:
                    pass

    @staticmethod
    def _safe_float(value: Any) -> float:
        try:
            number = float(value)
            return number if isfinite(number) and number > 0 else 0.0
        except (TypeError, ValueError, OverflowError):
            return 0.0

    @classmethod
    def _positive(cls, value: Any) -> bool:
        return cls._safe_float(value) > 0
