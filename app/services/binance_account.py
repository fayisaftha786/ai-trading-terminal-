from __future__ import annotations

from math import isfinite
from typing import Any


class BinanceAccountUnavailable(RuntimeError):
    pass


class BinanceReadOnlyAccount:
    """Production Binance Spot account visibility only. This class has no order methods."""

    def __init__(self, config: Any, exchange_factory: Any | None = None):
        self.config = config
        self._exchange_factory = exchange_factory

    def status(self) -> dict[str, Any]:
        configured = bool(self.config.binance_readonly_api_key and self.config.binance_readonly_api_secret)
        enabled = bool(self.config.binance_readonly_enabled)
        return {
            "provider": "Binance Spot",
            "environment": "production_read_only",
            "enabled": enabled,
            "credentials_configured": configured,
            "ready_for_connection_check": enabled and configured,
            "trading_permission_requested": False,
            "withdrawals_permission_requested": False,
            "order_execution_available": False,
            "live_trading_enabled": False,
        }

    def _new_exchange(self) -> Any:
        state = self.status()
        if not state["enabled"]:
            raise BinanceAccountUnavailable("Binance read-only account connection is disabled.")
        if not state["credentials_configured"]:
            raise BinanceAccountUnavailable("Read-only Binance API credentials are not configured.")
        try:
            if self._exchange_factory:
                exchange = self._exchange_factory({
                    "apiKey": self.config.binance_readonly_api_key,
                    "secret": self.config.binance_readonly_api_secret,
                    "enableRateLimit": True,
                    "timeout": 12000,
                    "options": {"defaultType": "spot"},
                })
            else:
                import ccxt  # type: ignore[import-not-found]
                exchange = ccxt.binance({
                    "apiKey": self.config.binance_readonly_api_key,
                    "secret": self.config.binance_readonly_api_secret,
                    "enableRateLimit": True,
                    "timeout": 12000,
                    "options": {"defaultType": "spot"},
                })
            return exchange
        except Exception as exc:
            raise BinanceAccountUnavailable(f"Binance connector unavailable: {type(exc).__name__}") from None

    @staticmethod
    def _close(exchange: Any) -> None:
        try:
            exchange.close()
        except Exception:
            pass

    @staticmethod
    def _safe_number(value: Any) -> float:
        try:
            number = float(value)
            return number if isfinite(number) and number >= 0 else 0.0
        except (TypeError, ValueError, OverflowError):
            return 0.0

    def check_account(self) -> dict[str, Any]:
        exchange = self._new_exchange()
        try:
            balance = exchange.fetch_balance()
            free = balance.get("free") or {}
            used = balance.get("used") or {}
            total = balance.get("total") or {}
            assets = sorted(
                key for key, value in total.items()
                if isinstance(value, (int, float)) and self._safe_number(value) > 0
            )
            return {
                "connected": True,
                "provider": "Binance Spot",
                "environment": "production_read_only",
                "available_assets": assets,
                "usdt_free": self._safe_number(free.get("USDT")),
                "usdt_used": self._safe_number(used.get("USDT")),
                "usdt_total": self._safe_number(total.get("USDT")),
                "trading_permission_requested": False,
                "withdrawals_permission_requested": False,
                "order_execution_available": False,
                "live_trading_enabled": False,
            }
        except Exception as exc:
            raise BinanceAccountUnavailable(
                f"Binance read-only account check failed: {type(exc).__name__}"
            ) from None
        finally:
            self._close(exchange)
