from __future__ import annotations

import hashlib
import sqlite3
import threading
from datetime import datetime, timezone
from math import isfinite
from typing import Any


class TestnetUnavailable(RuntimeError):
    __test__ = False


class TestnetOrderRejected(RuntimeError):
    __test__ = False


class TestnetOrderUncertain(RuntimeError):
    __test__ = False


class BinanceSpotTestnet:
    """Credential-isolated Binance Spot Testnet adapter; never targets production."""

    ALLOWED_ORDER_STATUSES = {
        "open": "OPEN", "new": "OPEN", "pending": "UNKNOWN",
        "closed": "FILLED", "filled": "FILLED", "canceled": "CANCELED",
        "cancelled": "CANCELED", "rejected": "REJECTED", "expired": "EXPIRED",
        "partially_filled": "PARTIALLY_FILLED", "unknown": "UNKNOWN",
    }
    DEFINITIVE_REJECTIONS = (
        "InvalidOrder", "InsufficientFunds", "AuthenticationError", "PermissionDenied",
        "BadRequest", "ArgumentsRequired", "BadSymbol",
    )

    def __init__(self, config: Any, exchange_factory: Any | None = None):
        self.config = config
        self._exchange_factory = exchange_factory
        # Serialize submission and emergency-stop paths in this local single-worker process.
        self._order_lock = threading.RLock()

    def status(self, halted: bool = False) -> dict[str, Any]:
        configured = bool(self.config.binance_testnet_api_key and self.config.binance_testnet_api_secret)
        enabled = bool(self.config.binance_testnet_enabled)
        orders_enabled = bool(self.config.binance_testnet_order_enabled)
        max_order = float(self.config.binance_testnet_max_order_usdt)
        return {
            "provider": "Binance Spot Testnet",
            "environment": "testnet_only",
            "enabled": enabled,
            "credentials_configured": configured,
            "ready_for_connection_check": enabled and configured,
            "order_execution_enabled": enabled and configured and orders_enabled and not halted and isfinite(max_order) and max_order > 0,
            "configured_order_gate": orders_enabled,
            "emergency_halted": bool(halted),
            "maximum_order_usdt": max_order if isfinite(max_order) and max_order > 0 else 0.0,
            "maximum_open_orders": max(1, min(int(self.config.binance_testnet_max_open_orders), 10)),
            "allowed_symbols": [s for s in tuple(self.config.cex_symbols) if isinstance(s, str) and s.endswith("/USDT")],
            "production_endpoint_used": False,
            "live_trading_enabled": False,
        }

    def _new_exchange(self) -> Any:
        state = self.status()
        if not state["enabled"]:
            raise TestnetUnavailable("Binance Spot Testnet is disabled. Set BINANCE_TESTNET_ENABLED=true locally.")
        if not state["credentials_configured"]:
            raise TestnetUnavailable("Testnet API credentials are missing. Configure them locally; never send them in chat.")
        try:
            if self._exchange_factory:
                exchange = self._exchange_factory({
                    "apiKey": self.config.binance_testnet_api_key,
                    "secret": self.config.binance_testnet_api_secret,
                    "enableRateLimit": True,
                    "timeout": 12000,
                    "options": {"defaultType": "spot"},
                })
            else:
                import ccxt  # type: ignore[import-not-found]
                exchange = ccxt.binance({
                    "apiKey": self.config.binance_testnet_api_key,
                    "secret": self.config.binance_testnet_api_secret,
                    "enableRateLimit": True,
                    "timeout": 12000,
                    "options": {"defaultType": "spot"},
                })
        except TestnetUnavailable:
            raise
        except Exception as exc:
            raise TestnetUnavailable(f"Testnet connector unavailable: {type(exc).__name__}") from None
        try:
            # CCXT requires sandbox mode as the first exchange call, before load_markets/auth calls.
            exchange.set_sandbox_mode(True)
        except Exception as exc:
            self._close(exchange)
            raise TestnetUnavailable(f"Unable to activate sandbox mode: {type(exc).__name__}") from None
        return exchange

    @staticmethod
    def _close(exchange: Any) -> None:
        try:
            exchange.close()
        except Exception:
            pass

    @staticmethod
    def _safe_float(value: Any) -> float:
        try:
            number = float(value)
            return number if isfinite(number) else 0.0
        except (TypeError, ValueError, OverflowError):
            return 0.0

    @classmethod
    def _normalise_order(cls, order: dict[str, Any]) -> dict[str, Any]:
        status = str(order.get("status") or "unknown").lower()
        filled = cls._safe_float(order.get("filled"))
        # Unknown provider-specific states must remain unresolved and count against
        # the open-order cap; never let an unfamiliar state bypass the safety ledger.
        normal_status = cls.ALLOWED_ORDER_STATUSES.get(status, "UNKNOWN")
        if normal_status == "OPEN" and filled > 0:
            normal_status = "PARTIALLY_FILLED"
        return {
            "exchange_order_id": str(order.get("id") or "") or None,
            "status": normal_status,
            "filled": filled,
            "remaining": cls._safe_float(order.get("remaining")),
            "average": cls._safe_float(order.get("average")) or None,
            "cost": cls._safe_float(order.get("cost")),
        }

    def check_account(self) -> dict[str, Any]:
        exchange = self._new_exchange()
        try:
            balance = exchange.fetch_balance()
            free = balance.get("free") or {}
            return {
                "connected": True,
                "provider": "Binance Spot Testnet",
                "environment": "testnet_only",
                "available_assets": sorted(k for k, v in free.items() if isinstance(v, (int, float)) and v > 0),
                "usdt_free": self._safe_float(free.get("USDT")),
                "production_endpoint_used": False,
                "live_trading_enabled": False,
            }
        except Exception as exc:
            raise TestnetUnavailable(f"Testnet account check failed: {type(exc).__name__}") from None
        finally:
            self._close(exchange)

    def create_limit_order(self, request: dict[str, Any], storage: Any) -> dict[str, Any]:
        with self._order_lock:
            return self._create_limit_order_locked(request, storage)

    def _create_limit_order_locked(self, request: dict[str, Any], storage: Any) -> dict[str, Any]:
        halted = bool(storage.get_setting("testnet_order_halted", False))
        state = self.status(halted=halted)
        if halted:
            raise TestnetUnavailable("Testnet emergency order lock is active. Reconcile all open orders before resetting it.")
        if not state["order_execution_enabled"]:
            raise TestnetUnavailable(
                "Testnet order execution is locked. Enable BINANCE_TESTNET_ENABLED, configure Testnet keys, "
                "and explicitly set BINANCE_TESTNET_ORDER_ENABLED=true locally."
            )
        symbol = str(request["symbol"])
        side = str(request["side"]).lower()
        if symbol not in tuple(self.config.cex_symbols):
            raise TestnetOrderRejected("Symbol is not in the configured CEX_SYMBOLS allowlist.")
        if not symbol.endswith("/USDT") or side not in {"buy", "sell"}:
            raise TestnetOrderRejected("Only allowlisted USDT spot markets and BUY/SELL limit orders are supported.")

        key = str(request["idempotency_key"])
        existing = storage.get_testnet_order_by_key(key)
        if existing:
            if existing["status"] in {"SUBMITTING", "UNKNOWN"}:
                raise TestnetOrderUncertain(
                    f"This request may already have reached the exchange (state {existing['status']}). "
                    "Reconcile it; do not submit again with a new key."
                )
            return {"order": existing, "replayed": True, "environment": "testnet_only"}

        client_order_id = "att" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:26]
        try:
            storage.create_testnet_order({
                "idempotency_key": key, "client_order_id": client_order_id, "symbol": symbol,
                "side": side.upper(), "amount": float(request["amount"]), "price": float(request["price"]),
                "notional_usdt": float(request["amount"]) * float(request["price"]), "status": "SUBMITTING",
            }, max_open_orders=state["maximum_open_orders"])
        except ValueError as exc:
            raise TestnetOrderRejected(str(exc)) from None
        except sqlite3.IntegrityError:
            # A concurrent request may have reserved the same idempotency key first.
            existing = storage.get_testnet_order_by_key(key)
            if existing and existing["status"] in {"SUBMITTING", "UNKNOWN"}:
                raise TestnetOrderUncertain(
                    f"This request is already in flight or ambiguous (state {existing['status']}); do not resubmit."
                ) from None
            if existing:
                return {"order": existing, "replayed": True, "environment": "testnet_only"}
            raise TestnetOrderRejected("Client order ID collision; choose a new idempotency key.") from None

        exchange = None
        submission_started = False
        try:
            exchange = self._new_exchange()
            exchange.load_markets()
            market = exchange.market(symbol)
            if not market or not market.get("active", True) or market.get("spot") is False:
                raise TestnetOrderRejected("The selected market is not an active spot market.")
            price = self._safe_float(exchange.price_to_precision(symbol, request["price"]))
            amount = self._safe_float(exchange.amount_to_precision(symbol, request["amount"]))
            notional = amount * price
            if price <= 0 or amount <= 0 or notional <= 0:
                raise TestnetOrderRejected("Order precision produced a zero or invalid amount/price.")
            max_notional = float(self.config.binance_testnet_max_order_usdt)
            if not isfinite(max_notional) or max_notional <= 0 or notional > max_notional + 1e-9:
                raise TestnetOrderRejected(f"Order value exceeds the configured {max_notional:g} USDT cap.")
            limits = market.get("limits") or {}
            min_amount = self._safe_float((limits.get("amount") or {}).get("min"))
            min_cost = self._safe_float((limits.get("cost") or {}).get("min"))
            if min_amount and amount < min_amount:
                raise TestnetOrderRejected("Order amount is below the exchange minimum.")
            if min_cost and notional < min_cost:
                raise TestnetOrderRejected("Order notional is below the exchange minimum.")

            balance = exchange.fetch_balance()
            free = balance.get("free") or {}
            base, quote = symbol.split("/", 1)
            needed_asset = quote if side == "buy" else base
            needed = notional * 1.002 if side == "buy" else amount
            if self._safe_float(free.get(needed_asset)) + 1e-12 < needed:
                raise TestnetOrderRejected(f"Insufficient free {needed_asset} balance for this Testnet limit order.")

            submission_started = True
            order = exchange.create_order(
                symbol, "limit", side, amount, price,
                {"timeInForce": "GTC", "clientOrderId": client_order_id},
            )
            normal = self._normalise_order(order)
            storage.update_testnet_order(client_order_id, {
                **normal, "amount": amount, "price": price, "notional_usdt": notional,
                "error_code": None,
            })
            saved = storage.get_testnet_order_by_client_id(client_order_id)
            return {"order": saved, "replayed": False, "environment": "testnet_only", "live_trading_enabled": False}
        except TestnetOrderRejected:
            storage.update_testnet_order(client_order_id, {"status": "REJECTED", "error_code": "LOCAL_VALIDATION"})
            raise
        except TestnetUnavailable:
            storage.update_testnet_order(client_order_id, {"status": "REJECTED", "error_code": "CONNECTOR_UNAVAILABLE"})
            raise
        except Exception as exc:
            exc_name = type(exc).__name__
            if not submission_started:
                # No create-order request was sent, so this is a definite preflight failure.
                storage.update_testnet_order(client_order_id, {"status": "REJECTED", "error_code": exc_name[:80]})
                raise TestnetUnavailable(f"Testnet pre-submit check failed: {exc_name}") from None
            if exc_name in self.DEFINITIVE_REJECTIONS:
                # Explicit exchange rejection is definitive; keeping it UNKNOWN would
                # permanently consume an unresolved-order slot despite no accepted order.
                storage.update_testnet_order(client_order_id, {"status": "REJECTED", "error_code": exc_name[:80]})
                raise TestnetOrderRejected(f"Binance Testnet definitively rejected this order: {exc_name}") from None
            # A timeout/network error may occur after the exchange accepted the order.
            # Never retry blindly; reconcile by client order ID first.
            storage.update_testnet_order(client_order_id, {"status": "UNKNOWN", "error_code": exc_name[:80]})
            raise TestnetOrderUncertain(
                f"Submission result is uncertain ({exc_name}). The app will not resubmit this order; "
                "reconcile its client order ID first."
            ) from None
        finally:
            if exchange is not None:
                self._close(exchange)

    def emergency_stop(self, storage: Any) -> dict[str, Any]:
        with self._order_lock:
            return self._emergency_stop_locked(storage)

    def _emergency_stop_locked(self, storage: Any) -> dict[str, Any]:
        # Persist the latch before making any network request so a restart cannot re-enable orders.
        storage.set_setting("testnet_order_halted", True)
        canceled: list[str] = []
        filled_during_stop: list[str] = []
        unresolved: list[str] = []
        # Do not use the UI's recent-history limit here: an older active order must
        # never be skipped merely because many terminal orders were created later.
        for local in storage.list_active_testnet_orders():
            client_id = local["client_order_id"]
            current = local
            if current["status"] in {"SUBMITTING", "UNKNOWN"}:
                try:
                    refreshed = self.refresh_order(client_id, storage)
                    current = refreshed["order"]
                except Exception:
                    unresolved.append(client_id)
                    continue
                if current["status"] == "UNKNOWN":
                    unresolved.append(client_id)
                    continue
            if current["status"] in {"OPEN", "PARTIALLY_FILLED"}:
                try:
                    canceled_result = self.cancel_order(client_id, storage)
                    final_status = (canceled_result.get("order") or {}).get("status")
                    if final_status == "CANCELED":
                        canceled.append(client_id)
                    elif final_status == "FILLED":
                        filled_during_stop.append(client_id)
                    else:
                        unresolved.append(client_id)
                except Exception:
                    unresolved.append(client_id)
        return {"halted": True, "new_orders_disabled": True, "canceled_client_order_ids": canceled,
                "filled_during_stop_client_order_ids": filled_during_stop,
                "unresolved_client_order_ids": unresolved, "live_trading_enabled": False,
                "message": "Only orders recorded by this app were targeted. Inspect exchange Testnet order history for any unresolved item."}

    def refresh_order(self, client_order_id: str, storage: Any) -> dict[str, Any]:
        with self._order_lock:
            return self._refresh_order_locked(client_order_id, storage)

    def _refresh_order_locked(self, client_order_id: str, storage: Any) -> dict[str, Any]:
        local = storage.get_testnet_order_by_client_id(client_order_id)
        if not local:
            raise TestnetUnavailable("Testnet order was not found in the local ledger.")
        if local.get("status") in {"REJECTED", "CANCELED", "FILLED", "EXPIRED"}:
            return {"order": local, "reconciled": True, "environment": "testnet_only"}
        exchange = self._new_exchange()
        try:
            exchange.load_markets()
            remote = None
            if local.get("exchange_order_id"):
                remote = exchange.fetch_order(local["exchange_order_id"], local["symbol"])
            else:
                # Recover a lost create response by scanning recent exchange orders for our stable client ID.
                created = datetime.fromisoformat(local["created_at"].replace("Z", "+00:00"))
                since = int(created.timestamp() * 1000) - 60_000
                if not exchange.has.get("fetchOrders"):
                    raise TestnetUnavailable("This CCXT version does not support order-history reconciliation.")
                candidates = exchange.fetch_orders(local["symbol"], since, 100)
                remote = next((o for o in candidates if str(o.get("clientOrderId") or "") == client_order_id), None)
            if not remote:
                # Absence is not proof of non-acceptance; keep UNKNOWN and never auto-resubmit.
                return {"order": local, "reconciled": False, "environment": "testnet_only",
                        "message": "No matching remote order found yet. Keep this request blocked and inspect Testnet order history."}
            normal = self._normalise_order(remote)
            storage.update_testnet_order(client_order_id, normal)
            return {"order": storage.get_testnet_order_by_client_id(client_order_id),
                    "reconciled": True, "environment": "testnet_only"}
        except TestnetUnavailable:
            raise
        except Exception as exc:
            raise TestnetUnavailable(f"Order reconciliation failed: {type(exc).__name__}") from None
        finally:
            self._close(exchange)

    def cancel_order(self, client_order_id: str, storage: Any) -> dict[str, Any]:
        with self._order_lock:
            return self._cancel_order_locked(client_order_id, storage)

    def _cancel_order_locked(self, client_order_id: str, storage: Any) -> dict[str, Any]:
        local = storage.get_testnet_order_by_client_id(client_order_id)
        if not local:
            raise TestnetUnavailable("Testnet order was not found in the local ledger.")
        if not local.get("exchange_order_id"):
            raise TestnetUnavailable("The exchange order ID is not known. Reconcile this order before cancellation.")
        if local.get("status") not in {"OPEN", "PARTIALLY_FILLED"}:
            raise TestnetUnavailable("Only an open or partially filled Testnet order can be canceled.")
        exchange = self._new_exchange()
        try:
            exchange.load_markets()
            remote = exchange.cancel_order(local["exchange_order_id"], local["symbol"])
            normal = self._normalise_order(remote)
            storage.update_testnet_order(client_order_id, normal)
            return {"order": storage.get_testnet_order_by_client_id(client_order_id),
                    "environment": "testnet_only", "live_trading_enabled": False}
        except Exception as exc:
            raise TestnetUnavailable(f"Testnet cancel request failed or is uncertain: {type(exc).__name__}") from None
        finally:
            self._close(exchange)
