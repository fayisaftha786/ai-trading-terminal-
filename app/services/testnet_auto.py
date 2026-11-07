from __future__ import annotations

import hashlib
import threading
from datetime import datetime, timezone
from math import isfinite
from typing import Any

from app.services.risk import RiskRejected, validate_risk_profile
from app.services.testnet import BinanceSpotTestnet, TestnetUnavailable


class TestnetAutoTrader:
    """Signal-driven Binance Spot Testnet execution with exchange-native OPOCO protection."""

    MAX_ENTRIES_PER_DAY = 3
    SYMBOL_COOLDOWN_SECONDS = 4 * 60 * 60

    def __init__(self, adapter: BinanceSpotTestnet, storage: Any, eligibility_engine: Any):
        self.adapter = adapter
        self.storage = storage
        self.eligibility_engine = eligibility_engine
        self._lock = threading.RLock()

    @staticmethod
    def _number(value: Any) -> float | None:
        try:
            result = float(value)
        except (TypeError, ValueError, OverflowError):
            return None
        return result if isfinite(result) else None

    @staticmethod
    def _utc_day_start(now: datetime) -> str:
        return now.astimezone(timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0
        ).isoformat()

    def _daily_loss_limit(self) -> float:
        value = self._number(getattr(self.adapter.config, "binance_testnet_daily_max_loss_usdt", 2.0))
        return value if value is not None and value > 0 else 2.0

    def _daily_loss_guard(self, now: datetime) -> dict[str, Any]:
        day_start = self._utc_day_start(now)
        accounting = self.storage.testnet_auto_daily_accounting(day_start)
        halted_day = self.storage.get_setting("testnet_auto_loss_halt_day")
        limit = self._daily_loss_limit()
        triggered = accounting["realized_pnl_usdt"] <= -limit
        if triggered and halted_day != day_start:
            # Persist the daily halt before returning; it survives process restarts.
            self.storage.set_setting("testnet_auto_loss_halt_day", day_start)
            self.storage.log_event(
                "testnet_auto_daily_loss_stop",
                "Testnet automatic entries halted by daily realized-loss limit",
                {"day_start_utc": day_start, "realized_pnl_usdt": accounting["realized_pnl_usdt"],
                 "limit_usdt": limit, "scope": "bot_only_exact_fee_accounted_trades"},
            )
            halted_day = day_start
        active_halt = halted_day == day_start
        unresolved = accounting["unresolved_closed_trades"] > 0
        return {
            **accounting,
            "limit_usdt": limit,
            "day_start_utc": day_start,
            "halted": active_halt or unresolved,
            "reason": "daily_loss_limit_reached" if active_halt else (
                "closed_trade_fee_accounting_unresolved" if unresolved else None
            ),
        }

    def status(self, entry_enabled: bool) -> dict[str, Any]:
        halted = bool(self.storage.get_setting("testnet_order_halted", False))
        adapter_status = self.adapter.status(halted=halted)
        active = self.storage.list_active_testnet_auto_orders()
        daily_risk = self._daily_loss_guard(datetime.now(timezone.utc))
        return {
            "enabled": bool(entry_enabled),
            "daily_risk": daily_risk,
            "mode": "testnet_only",
            "provider": "Binance Spot Testnet",
            "order_execution_enabled": bool(adapter_status["order_execution_enabled"]),
            "emergency_halted": halted,
            "active_order_lists": len(active),
            "max_entries_per_day": self.MAX_ENTRIES_PER_DAY,
            "daily_max_loss_usdt": self._daily_loss_limit(),
            "daily_loss_scope": "bot-only completed Testnet auto-trades with exact fees; UTC day",
            "daily_loss_halt_day": self.storage.get_setting("testnet_auto_loss_halt_day"),
            "protection": "Binance native OPOCO (net received BUY quantity + take-profit/stop-loss OCO)",
            "live_trading_enabled": False,
        }

    @classmethod
    def _is_fully_filled_order(cls, order: dict[str, Any]) -> bool:
        """Require exchange status and quantity agreement before clearing exposure."""
        if str(order.get("status") or "").lower() != "closed":
            return False
        amount = cls._number(order.get("amount"))
        filled = cls._number(order.get("filled"))
        if amount is None or filled is None or amount <= 0 or filled <= 0:
            return False
        return filled >= amount - max(1e-12, amount * 1e-8)

    @staticmethod
    def _fees_to_quote(
        raw_fees: Any, quote: str, base: str, fill_price: float
    ) -> tuple[float | None, bool]:
        if not isinstance(raw_fees, list) or not raw_fees:
            return None, False
        total = 0.0
        for fee in raw_fees:
            if not isinstance(fee, dict):
                return None, False
            cost = TestnetAutoTrader._number(fee.get("cost"))
            currency = str(fee.get("currency") or "").upper()
            if cost is None or cost < 0 or not currency:
                return None, False
            if currency == quote:
                total += cost
            elif currency == base:
                total += cost * fill_price
            else:
                # Third-asset conversion requires its historical fill-time FX price.
                # Never use a later spot quote or silently record zero fees.
                return None, False
        return total, True

    def _order_fee_quote(
        self, exchange: Any, order: dict[str, Any], order_id: Any, symbol: str,
        quote: str, base: str, average: float,
    ) -> tuple[float | None, bool]:
        """Prefer actual trade-level commissions because order snapshots can omit fees."""
        raw_fees = order.get("fees")
        if not raw_fees and isinstance(order.get("fee"), dict):
            raw_fees = [order["fee"]]
        if raw_fees:
            return self._fees_to_quote(raw_fees, quote, base, average)

        fills: Any = None
        fetch_order_trades = getattr(exchange, "fetch_order_trades", None)
        if callable(fetch_order_trades):
            try:
                fills = fetch_order_trades(order_id, symbol)
            except Exception:
                fills = None
        if not fills:
            # Binance myTrades returns commission and commissionAsset per execution.
            fetch_my_trades = getattr(exchange, "fetch_my_trades", None)
            if callable(fetch_my_trades):
                try:
                    numeric_order_id = int(order_id) if str(order_id).isdigit() else order_id
                    fills = fetch_my_trades(symbol, None, None, {"orderId": numeric_order_id})
                except Exception:
                    fills = None
        if not isinstance(fills, list) or not fills:
            return None, False

        expected_filled = self._number(order.get("filled"))
        if expected_filled is None or expected_filled <= 0:
            return None, False
        observed_filled = 0.0
        total_fee = 0.0
        for trade in fills:
            if not isinstance(trade, dict):
                return None, False
            trade_order_id = trade.get("order")
            if trade_order_id is not None and str(trade_order_id) != str(order_id):
                return None, False
            qty = self._number(trade.get("amount"))
            price = self._number(trade.get("price"))
            if qty is None or qty <= 0 or price is None or price <= 0:
                return None, False
            trade_fees = trade.get("fees")
            if not trade_fees and isinstance(trade.get("fee"), dict):
                trade_fees = [trade["fee"]]
            fee_quote, fee_exact = self._fees_to_quote(trade_fees, quote, base, price)
            if not fee_exact or fee_quote is None:
                return None, False
            observed_filled += qty
            total_fee += fee_quote

        tolerance = max(1e-12, expected_filled * 1e-8)
        if abs(observed_filled - expected_filled) > tolerance:
            return None, False
        return total_fee, True

    def _record_closed_fill_ledger(
        self, exchange: Any, row: dict[str, Any], working_id: Any,
        exit_orders: list[dict[str, Any]],
    ) -> None:
        """Persist only a fully exited position and verified trade-level commissions."""
        positive_exits = [
            item for item in exit_orders
            if (self._number(item.get("filled")) or 0.0) > 0
        ]
        # Save child IDs before checking fill details so temporary provider omissions
        # can be retried later without losing the exchange trade link.
        self.storage.update_testnet_auto_order(row["list_client_order_id"], {
            "above_order_id": str(exit_orders[0].get("id") or "") if exit_orders else None,
            "below_order_id": str(exit_orders[1].get("id") or "") if len(exit_orders) > 1 else None,
        })
        entry = exchange.fetch_order(working_id, row["symbol"])
        if (not self._is_fully_filled_order(entry) or len(positive_exits) != 1
                or not self._is_fully_filled_order(positive_exits[0])):
            self.storage.update_testnet_auto_order(row["list_client_order_id"], {
                "accounting_status": "FILL_DATA_UNAVAILABLE",
            })
            return

        base, quote = row["symbol"].split("/", 1)
        entry_qty = self._number(entry.get("filled"))
        entry_avg = self._number(entry.get("average"))
        entry_cost = self._number(entry.get("cost"))
        if entry_cost is None and entry_qty is not None and entry_avg is not None:
            entry_cost = entry_qty * entry_avg
        exit_order = positive_exits[0]
        exit_qty = self._number(exit_order.get("filled"))
        exit_avg = self._number(exit_order.get("average"))
        exit_proceeds = self._number(exit_order.get("cost"))
        if exit_proceeds is None and exit_qty is not None and exit_avg is not None:
            exit_proceeds = exit_qty * exit_avg
        if (entry_qty is None or entry_cost is None or entry_avg is None or entry_qty <= 0
                or entry_cost <= 0 or exit_qty is None or exit_proceeds is None
                or exit_avg is None or exit_qty <= 0 or exit_proceeds <= 0):
            self.storage.update_testnet_auto_order(row["list_client_order_id"], {
                "accounting_status": "FILL_DATA_UNAVAILABLE",
            })
            return

        entry_fee, entry_fee_exact = self._order_fee_quote(
            exchange, entry, working_id, row["symbol"], quote, base, entry_avg
        )
        exit_order_id = exit_order.get("id")
        exit_fee, exit_fee_exact = self._order_fee_quote(
            exchange, exit_order, exit_order_id, row["symbol"], quote, base, exit_avg
        ) if exit_order_id is not None else (None, False)
        exact = entry_fee_exact and entry_fee is not None and exit_fee_exact and exit_fee is not None
        pnl = exit_proceeds - entry_cost - entry_fee - exit_fee if exact else None
        self.storage.update_testnet_auto_order(row["list_client_order_id"], {
            "entry_filled_qty": entry_qty,
            "entry_cost_quote": entry_cost,
            "entry_fee_quote": entry_fee,
            "exit_filled_qty": exit_qty,
            "exit_proceeds_quote": exit_proceeds,
            "exit_fee_quote": exit_fee,
            "realized_pnl_quote": pnl,
            "accounting_status": "EXACT" if exact else "FEES_UNRESOLVED",
        })

    def _reconcile_locked(self) -> dict[str, int]:
        rows = self.storage.list_active_testnet_auto_orders()
        counts = {"checked": 0, "executing": 0, "completed": 0, "unresolved": 0,
                  "accounting_retried": 0, "accounting_resolved": 0}
        unaccounted = self.storage.list_unaccounted_testnet_auto_orders()
        if not rows and not unaccounted:
            return counts
        exchange = None
        try:
            exchange = self.adapter._new_exchange()
            for row in rows:
                counts["checked"] += 1
                try:
                    params: dict[str, Any] = {"origClientOrderId": row["list_client_order_id"]}
                    if row.get("exchange_list_id") is not None:
                        params = {"orderListId": row["exchange_list_id"]}
                    remote_list = exchange.request("orderList", "private", "GET", params)
                    list_status = str(remote_list.get("listOrderStatus") or "").upper()
                    orders = remote_list.get("orders") or []
                    working_id = row.get("working_order_id")
                    if not working_id and orders:
                        working_id = orders[0].get("orderId")
                    if not working_id:
                        raise ValueError("OPOCO working order ID is unavailable")
                    working = exchange.fetch_order(working_id, row["symbol"])
                    working_status = str(working.get("status") or "unknown").lower()

                    if working_status in {"canceled", "cancelled", "expired", "rejected"}:
                        # FOK should be all-or-none, but never assume a terminal
                        # status means zero exposure. Any reported fill must remain
                        # unresolved until its protection is independently verified.
                        terminal_filled = self._number(working.get("filled")) or 0.0
                        if terminal_filled > 0:
                            self.storage.update_testnet_auto_order(row["list_client_order_id"], {
                                "working_order_id": str(working_id),
                                "status": "UNPROTECTED",
                                "error_code": "PARTIALLY_FILLED_ENTRY_WITHOUT_PROTECTED_EXIT",
                            })
                            counts["unresolved"] += 1
                        else:
                            self.storage.update_testnet_auto_order(row["list_client_order_id"], {
                                "working_order_id": str(working_id),
                                "status": "NOT_FILLED",
                                "error_code": None,
                            })
                            counts["completed"] += 1
                        continue

                    if working_status == "closed":
                        if not self._is_fully_filled_order(working):
                            self.storage.update_testnet_auto_order(row["list_client_order_id"], {
                                "working_order_id": str(working_id),
                                "status": "UNPROTECTED",
                                "error_code": "CLOSED_ENTRY_FILL_QUANTITY_MISMATCH",
                            })
                            counts["unresolved"] += 1
                            continue
                        exit_ids = [
                            item.get("orderId") for item in orders
                            if str(item.get("orderId")) != str(working_id) and item.get("orderId") is not None
                        ]
                        exit_orders = []
                        for order_id in exit_ids:
                            try:
                                exit_orders.append(exchange.fetch_order(order_id, row["symbol"]))
                            except Exception:
                                exit_orders.append({"status": "unknown", "filled": 0})
                        exit_states = [
                            str(item.get("status") or "unknown").lower() for item in exit_orders
                        ]
                        # ALL_DONE alone is not enough: exactly one exit leg must be
                        # fully filled. A partial SELL can leave residual unprotected base.
                        positive_exit_fills = [
                            item for item in exit_orders
                            if (self._number(item.get("filled")) or 0.0) > 0
                        ]
                        completed_exit = (
                            list_status == "ALL_DONE"
                            and len(positive_exit_fills) == 1
                            and self._is_fully_filled_order(positive_exit_fills[0])
                        )
                        if completed_exit:
                            self._record_closed_fill_ledger(
                                exchange, row, working_id, exit_orders
                            )
                            self.storage.update_testnet_auto_order(row["list_client_order_id"], {
                                "working_order_id": str(working_id),
                                "status": "CLOSED",
                                "error_code": None,
                                "closed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                            })
                            counts["completed"] += 1
                        elif list_status in {"EXECUTING", "EXEC_STARTED"} and any(
                            state in {"open", "pending"} for state in exit_states
                        ):
                            self.storage.update_testnet_auto_order(row["list_client_order_id"], {
                                "working_order_id": str(working_id),
                                "status": "EXECUTING",
                                "error_code": None,
                            })
                            counts["executing"] += 1
                        else:
                            # A filled entry without a positively verified completed
                            # bracket or live protective child is not safe to clear.
                            self.storage.update_testnet_auto_order(row["list_client_order_id"], {
                                "working_order_id": str(working_id),
                                "status": "UNPROTECTED",
                                "error_code": "FILLED_ENTRY_WITHOUT_CONFIRMED_EXIT",
                            })
                            counts["unresolved"] += 1
                        continue

                    if working_status in {"open", "pending"} and (self._number(working.get("filled")) or 0.0) > 0:
                        self.storage.update_testnet_auto_order(row["list_client_order_id"], {
                            "working_order_id": str(working_id),
                            "status": "UNPROTECTED",
                            "error_code": "PARTIALLY_FILLED_WORKING_ORDER_HAS_NO_ACTIVE_OPOCO_EXITS",
                        })
                        counts["unresolved"] += 1
                        continue

                    if working_status in {"open", "pending"} and list_status in {"EXECUTING", "EXEC_STARTED"}:
                        self.storage.update_testnet_auto_order(row["list_client_order_id"], {
                            "working_order_id": str(working_id),
                            "status": "EXECUTING",
                            "error_code": None,
                        })
                        counts["executing"] += 1
                    else:
                        self.storage.update_testnet_auto_order(row["list_client_order_id"], {
                            "working_order_id": str(working_id),
                            "status": "UNKNOWN",
                            "error_code": "UNRECOGNIZED_ORDER_LIST_OR_WORKING_ORDER_STATE",
                        })
                        counts["unresolved"] += 1
                except Exception:
                    # Unknown remote state must block replacement orders.
                    self.storage.update_testnet_auto_order(row["list_client_order_id"], {
                        "status": "UNKNOWN", "error_code": "RECONCILIATION_UNAVAILABLE",
                    })
                    counts["unresolved"] += 1
            # Retry closed records whose commissions/fill details were temporarily
            # unavailable. Never guess fees or reopen a completed position.
            for row in unaccounted:
                try:
                    working_id = row.get("working_order_id")
                    if not working_id:
                        continue
                    entry = exchange.fetch_order(working_id, row["symbol"])
                    child_ids = [row.get("above_order_id"), row.get("below_order_id")]
                    exit_orders = [
                        exchange.fetch_order(order_id, row["symbol"])
                        for order_id in child_ids if order_id
                    ]
                    counts["accounting_retried"] += 1
                    self._record_closed_fill_ledger(exchange, row, working_id, exit_orders)
                    updated = self.storage.get_testnet_auto_order_by_key(row["idempotency_key"])
                    if updated and updated.get("accounting_status") == "EXACT":
                        counts["accounting_resolved"] += 1
                except Exception:
                    # CLOSED stays closed; unresolved P&L stays excluded.
                    continue
        except Exception:
            for row in rows:
                self.storage.update_testnet_auto_order(row["list_client_order_id"], {
                    "status": "UNKNOWN", "error_code": "RECONCILIATION_UNAVAILABLE",
                })
            counts["unresolved"] = len(rows)
        finally:
            if exchange is not None:
                self.adapter._close(exchange)
        return counts

    def reconcile(self) -> dict[str, int]:
        with self._lock:
            return self._reconcile_locked()

    def run(
        self,
        candidates: list[dict[str, Any]],
        entry_enabled: bool,
        now_ms: float | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            halted = bool(self.storage.get_setting("testnet_order_halted", False))
            self._reconcile_locked()
            result: dict[str, Any] = {
                "enabled": bool(entry_enabled),
                "mode": "testnet_only",
                "submitted": [],
                "rejected": [],
                "reconciliation": self._reconcile_summary(),
                "live_trading_enabled": False,
            }
            if not entry_enabled:
                result["status"] = "disabled"
                return result
            daily_guard = self._daily_loss_guard(datetime.now(timezone.utc))
            result["daily_risk"] = daily_guard
            if daily_guard["halted"]:
                result["status"] = "blocked_daily_loss_or_unresolved_accounting"
                result["rejected"].append({"reason": daily_guard["reason"]})
                return result
            state = self.adapter.status(halted=halted)
            if not state["order_execution_enabled"]:
                result["status"] = "blocked_testnet_order_gate"
                result["rejected"].append({"reason": "testnet_order_gate_disabled_or_halted"})
                return result
            if any(row["status"] in {"UNKNOWN", "UNPROTECTED"}
                   for row in self.storage.list_active_testnet_auto_orders()):
                result["status"] = "blocked_unresolved_order_list"
                result["rejected"].append({"reason": "reconcile_unknown_order_lists_before_new_entries"})
                return result

            try:
                risk = validate_risk_profile(self.storage.get_risk())
            except RiskRejected as exc:
                result["status"] = "blocked_invalid_risk_profile"
                result["rejected"].append({"reason": str(exc)})
                return result

            active = self.storage.list_active_testnet_auto_orders()
            max_positions = max(1, min(int(state["maximum_open_orders"]), 3))
            total_active_orders = self.storage.count_open_testnet_orders()
            if total_active_orders >= max_positions:
                result["status"] = "active_position_limit"
                result["rejected"].append({"reason": "maximum_combined_manual_and_automatic_testnet_orders_reached"})
                return result

            now = datetime.now(timezone.utc)
            day_start = self._utc_day_start(now)
            if self.storage.count_testnet_auto_entries_since(day_start) >= self.MAX_ENTRIES_PER_DAY:
                result["status"] = "daily_entry_cap"
                result["rejected"].append({"reason": "daily_testnet_auto_entry_cap_reached"})
                return result

            ordered = sorted(
                candidates,
                key=lambda item: self.eligibility_engine._score(item),
                reverse=True,
            )
            for item in ordered:
                allowed, reason, spread_bps = self.eligibility_engine._eligible(
                    item, now_ms if now_ms is not None else datetime.now(timezone.utc).timestamp() * 1000, risk
                )
                ticker = item.get("ticker") or {}
                symbol = str(ticker.get("symbol") or item.get("symbol") or "")
                if not allowed:
                    result["rejected"].append({"symbol": symbol, "reason": reason})
                    continue
                if not symbol.endswith("/USDT"):
                    result["rejected"].append({"symbol": symbol, "reason": "testnet_auto_trading_requires_usdt_spot_pair"})
                    continue
                manual_active = self.storage.list_active_testnet_orders()
                if (any(row["symbol"] == symbol for row in active)
                        or any(row["symbol"] == symbol and row["status"] in {"OPEN", "PARTIALLY_FILLED", "SUBMITTING", "UNKNOWN"}
                               for row in manual_active)):
                    result["rejected"].append({"symbol": symbol, "reason": "active_testnet_order_exists_for_symbol"})
                    continue
                last_order = self.storage.last_testnet_auto_entry(symbol)
                if last_order:
                    try:
                        previous = datetime.fromisoformat(last_order.replace("Z", "+00:00"))
                        if (now - previous).total_seconds() < self.SYMBOL_COOLDOWN_SECONDS:
                            result["rejected"].append({"symbol": symbol, "reason": "symbol_cooldown"})
                            continue
                    except ValueError:
                        result["rejected"].append({"symbol": symbol, "reason": "invalid_previous_order_timestamp"})
                        continue
                submitted = self._submit_protected_entry(item, risk, spread_bps)
                if submitted.get("accepted"):
                    result["submitted"].append(submitted["order"])
                    result["status"] = "submitted"
                    break
                result["rejected"].append({"symbol": symbol, "reason": submitted.get("reason", "submission_failed")})
            else:
                result["status"] = "no_eligible_entry"
            result["reconciliation"] = self._reconcile_summary()
            return result

    def _reconcile_summary(self) -> dict[str, int]:
        statuses = [row["status"] for row in self.storage.list_active_testnet_auto_orders()]
        return {
            "active": len(statuses),
            "unknown": sum(1 for status in statuses if status in {"UNKNOWN", "UNPROTECTED"}),
            "executing": sum(1 for status in statuses if status == "EXECUTING"),
        }

    def _submit_protected_entry(
        self, item: dict[str, Any], risk: dict[str, Any], spread_bps: float
    ) -> dict[str, Any]:
        ticker = item.get("ticker") or {}
        symbol = str(ticker.get("symbol") or item.get("symbol") or "")
        # Idempotency is keyed to the strategy candle, not each new live ticker tick.
        candle_stamp = item.get("last_closed_candle_timestamp_ms") or ticker.get("timestamp") or "unknown"
        key_source = f"{symbol}:{candle_stamp}"
        digest = hashlib.sha256(key_source.encode("utf-8")).hexdigest()
        idempotency_key = "auto_" + digest[:48]
        list_client_id = "att" + digest[:24]
        prior = self.storage.get_testnet_auto_order_by_key(idempotency_key)
        if prior:
            return {"accepted": False, "reason": "duplicate_signal_already_recorded"}

        exchange = None
        submission_started = False
        try:
            exchange = self.adapter._new_exchange()
            exchange.load_markets()
            market = exchange.market(symbol)
            if not market or not market.get("active", True) or market.get("spot") is False:
                return {"accepted": False, "reason": "testnet_market_not_active_spot"}
            market_info = market.get("info") or {}
            if not all(market_info.get(flag) is True for flag in ("otoAllowed", "opoAllowed", "ocoAllowed")):
                return {"accepted": False, "reason": "testnet_symbol_does_not_confirm_OPOCO_permissions"}
            balance = exchange.fetch_balance()
            free_usdt = self._number((balance.get("free") or {}).get("USDT"))
            ask = self._number(ticker.get("ask"))
            if free_usdt is None or ask is None or free_usdt <= 0 or ask <= 0:
                return {"accepted": False, "reason": "testnet_usdt_balance_or_ask_unavailable"}

            fee_bps = float(risk["fee_bps_per_side"])
            slippage_bps = float(risk["slippage_bps"])
            stop_pct = float(risk["stop_loss_pct"])
            target_pct = float(risk["take_profit_pct"])
            risk_cost_fraction = (
                stop_pct / 100.0
                + (2.0 * (fee_bps + slippage_bps) + max(0.0, spread_bps)) / 10_000.0
            )
            if not isfinite(risk_cost_fraction) or risk_cost_fraction <= 0:
                return {"accepted": False, "reason": "invalid_risk_cost_assumption"}
            risk_budget = free_usdt * float(risk["risk_per_trade_pct"]) / 100.0
            risk_sized_notional = risk_budget / risk_cost_fraction
            # Reconstruct the USDT equity slice already committed to this bot so the
            # exposure cap applies to the whole open book, not separately to every entry.
            current_auto_exposure = sum(
                max(0.0, self._number(row.get("notional_usdt")) or 0.0)
                for row in self.storage.list_active_testnet_auto_orders()
            )
            current_manual_exposure = sum(
                max(0.0, self._number(row.get("notional_usdt")) or 0.0)
                for row in self.storage.list_active_testnet_orders()
                if row.get("status") in {"OPEN", "PARTIALLY_FILLED", "SUBMITTING", "UNKNOWN"}
            )
            current_total_exposure = current_auto_exposure + current_manual_exposure
            reconstructed_usdt_equity = free_usdt + current_total_exposure
            exposure_cap = max(
                0.0,
                reconstructed_usdt_equity * float(risk["max_total_exposure_pct"]) / 100.0
                - current_total_exposure,
            )
            max_order = float(self.adapter.config.binance_testnet_max_order_usdt)
            notional = min(risk_sized_notional, exposure_cap, max_order, free_usdt / 1.002)
            if not isfinite(notional) or notional <= 0:
                return {"accepted": False, "reason": "testnet_position_size_is_zero"}

            raw_entry_limit = ask * (1.0 + slippage_bps / 10_000.0)
            entry_price = self._number(exchange.price_to_precision(symbol, raw_entry_limit))
            if entry_price is None or entry_price <= 0:
                return {"accepted": False, "reason": "invalid_testnet_entry_price"}
            amount = self._number(exchange.amount_to_precision(symbol, notional / entry_price))
            if amount is None or amount <= 0:
                return {"accepted": False, "reason": "testnet_amount_precision_became_zero"}
            actual_notional = amount * entry_price
            # OPOCO lets Binance derive pending SELL quantity from the net base
            # asset actually received by the working BUY, after applicable commission.
            # This avoids guessing a fixed fee reserve that can leave dust or reject exits.
            limits = market.get("limits") or {}
            min_amount = self._number((limits.get("amount") or {}).get("min")) or 0.0
            min_cost = self._number((limits.get("cost") or {}).get("min")) or 0.0
            if amount < min_amount or actual_notional < min_cost:
                return {"accepted": False, "reason": "testnet_order_below_exchange_minimum"}
            if actual_notional > max_order + 1e-9 or actual_notional * 1.002 > free_usdt:
                return {"accepted": False, "reason": "testnet_order_exceeds_balance_or_notional_cap"}

            stop_price = self._number(exchange.price_to_precision(
                symbol, entry_price * (1.0 - stop_pct / 100.0)
            ))
            target_price = self._number(exchange.price_to_precision(
                symbol, entry_price * (1.0 + target_pct / 100.0)
            ))
            last_price = self._number(ticker.get("last"))
            # Exchange validates pending OPOCO quantity after the working BUY fills;
            # stop/target quote value is screened against the expected net fill.
            expected_net_quantity = amount * 0.998
            if (
                expected_net_quantity < min_amount
                or (stop_price is not None and expected_net_quantity * stop_price < min_cost)
                or (target_price is not None and expected_net_quantity * target_price < min_cost)
            ):
                return {"accepted": False, "reason": "expected_net_protected_exit_below_exchange_minimum"}
            if (stop_price is None or target_price is None or last_price is None
                    or stop_price <= 0 or target_price <= last_price or stop_price >= last_price):
                return {"accepted": False, "reason": "invalid_oco_stop_or_target_price"}
            if spread_bps > self.eligibility_engine.MAX_SPREAD_BPS:
                return {"accepted": False, "reason": "spread_exceeds_testnet_execution_limit"}

            self.storage.create_testnet_auto_order({
                "idempotency_key": idempotency_key,
                "list_client_order_id": list_client_id,
                "symbol": symbol,
                "quantity": amount,
                "exit_quantity": amount,
                "entry_price": entry_price,
                "stop_price": stop_price,
                "target_price": target_price,
                "notional_usdt": actual_notional,
                "signal_score": float((item.get("analysis") or {}).get("score") or 0),
                "status": "SUBMITTING",
            }, max_open_orders=max(1, min(int(self.adapter.config.binance_testnet_max_open_orders), 3)))

            params = {
                "symbol": market.get("id") or symbol.replace("/", ""),
                "listClientOrderId": list_client_id,
                "workingType": "LIMIT",
                "workingSide": "BUY",
                "workingPrice": entry_price,
                "workingQuantity": amount,
                "workingTimeInForce": "FOK",
                "pendingSide": "SELL",
                # OPOCO calculates the pending SELL quantity from the actual net
                # base asset received by the fully-filled working BUY.
                "pendingAboveType": "TAKE_PROFIT",
                "pendingAboveStopPrice": target_price,
                "pendingBelowType": "STOP_LOSS",
                "pendingBelowStopPrice": stop_price,
                "newOrderRespType": "RESULT",
                "recvWindow": 5000,
            }
            submission_started = True
            response = exchange.request("orderList/opoco", "private", "POST", params)
            orders = response.get("orders") or []
            reports = response.get("orderReports") or []
            working_order_id = (orders[0].get("orderId") if orders else None)
            if not working_order_id and reports:
                working_order_id = reports[0].get("orderId")
            exchange_list_id = response.get("orderListId")
            list_state = str(response.get("listOrderStatus") or "").upper()
            status = "EXECUTING" if list_state == "EXECUTING" and exchange_list_id is not None else "UNKNOWN"
            self.storage.update_testnet_auto_order(list_client_id, {
                "exchange_list_id": str(exchange_list_id) if exchange_list_id is not None else None,
                "working_order_id": str(working_order_id) if working_order_id is not None else None,
                "status": status,
                "error_code": None if status == "EXECUTING" else "ORDER_LIST_RESPONSE_INCOMPLETE",
            })
            saved = self.storage.get_testnet_auto_order_by_key(idempotency_key)
            if status != "EXECUTING":
                return {"accepted": False, "reason": "order_list_response_requires_reconciliation"}
            return {
                "accepted": True,
                "order": {
                    "symbol": symbol,
                    "status": status,
                    "order_list_id": str(exchange_list_id),
                    "entry_price": entry_price,
                    "quantity": amount,
                    "protected_exit_quantity": "exchange_calculated_net_received_quantity",
                    "stop_loss": stop_price,
                    "take_profit": target_price,
                    "notional_usdt": actual_notional,
                    "signal_score": saved["signal_score"],
                    "environment": "testnet_only",
                    "live_trading_enabled": False,
                },
            }
        except Exception as exc:
            if submission_started:
                self.storage.update_testnet_auto_order(list_client_id, {
                    "status": "UNKNOWN", "error_code": type(exc).__name__[:80],
                })
                return {"accepted": False, "reason": "submission_uncertain_reconciliation_required"}
            return {"accepted": False, "reason": f"testnet_preflight_failed_{type(exc).__name__}"}
        finally:
            if exchange is not None:
                self.adapter._close(exchange)

    def emergency_stop(self) -> dict[str, Any]:
        with self._lock:
            self.storage.set_setting("testnet_auto_trading_enabled", False)
            canceled: list[str] = []
            completed: list[str] = []
            protected: list[str] = []
            unresolved: list[str] = []
            # Refresh all order-list and child-order states before deciding what can be
            # canceled. A filled entry must keep its exchange-side TP/SL OCO protection.
            self._reconcile_locked()
            rows = self.storage.list_active_testnet_auto_orders()
            exchange = None
            if rows:
                try:
                    exchange = self.adapter._new_exchange()
                    for row in rows:
                        list_id = row.get("exchange_list_id")
                        try:
                            if not list_id:
                                unresolved.append(row["list_client_order_id"])
                                continue
                            if row["status"] in {"EXECUTING", "UNPROTECTED", "UNKNOWN"}:
                                params: dict[str, Any] = {"orderListId": list_id}
                                remote_list = exchange.request("orderList", "private", "GET", params)
                                child_orders = remote_list.get("orders") or []
                                working_id = row.get("working_order_id") or (
                                    child_orders[0].get("orderId") if child_orders else None
                                )
                                if not working_id:
                                    unresolved.append(row["list_client_order_id"])
                                    continue
                                working = exchange.fetch_order(working_id, row["symbol"])
                                working_status = str(working.get("status") or "unknown").lower()
                                if working_status == "closed":
                                    if not self._is_fully_filled_order(working):
                                        self.storage.update_testnet_auto_order(row["list_client_order_id"], {
                                            "status": "UNPROTECTED",
                                            "error_code": "CLOSED_ENTRY_FILL_QUANTITY_MISMATCH",
                                        })
                                        unresolved.append(row["list_client_order_id"])
                                        continue
                                    exit_ids = [
                                        item.get("orderId") for item in child_orders
                                        if str(item.get("orderId")) != str(working_id) and item.get("orderId") is not None
                                    ]
                                    exit_orders = []
                                    for order_id in exit_ids:
                                        exit_order = exchange.fetch_order(order_id, row["symbol"])
                                        exit_orders.append(exit_order)
                                    exit_states = [
                                        str(exit_order.get("status") or "unknown").lower()
                                        for exit_order in exit_orders
                                    ]
                                    positive_exit_fills = [
                                        exit_order for exit_order in exit_orders
                                        if (self._number(exit_order.get("filled")) or 0.0) > 0
                                    ]
                                    completed_exit = (
                                        str(remote_list.get("listOrderStatus") or "").upper() == "ALL_DONE"
                                        and len(positive_exit_fills) == 1
                                        and self._is_fully_filled_order(positive_exit_fills[0])
                                    )
                                    if completed_exit:
                                        self._record_closed_fill_ledger(
                                            exchange, row, working_id, exit_orders
                                        )
                                        self.storage.update_testnet_auto_order(row["list_client_order_id"], {
                                            "status": "CLOSED", "error_code": None,
                                            "closed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                                        })
                                        completed.append(row["list_client_order_id"])
                                    elif any(state in {"open", "pending"} for state in exit_states):
                                        # Entry is filled and at least one native TP/SL exit remains active.
                                        protected.append(row["list_client_order_id"])
                                    else:
                                        # Never cancel an exit list or claim protection when its
                                        # live child orders cannot be verified.
                                        self.storage.update_testnet_auto_order(row["list_client_order_id"], {
                                            "status": "UNPROTECTED",
                                            "error_code": "FILLED_ENTRY_WITHOUT_LIVE_EXIT_ORDERS",
                                        })
                                        unresolved.append(row["list_client_order_id"])
                                    continue
                                if working_status in {"canceled", "cancelled", "expired", "rejected"}:
                                    terminal_filled = self._number(working.get("filled")) or 0.0
                                    if terminal_filled > 0:
                                        self.storage.update_testnet_auto_order(row["list_client_order_id"], {
                                            "status": "UNPROTECTED",
                                            "error_code": "PARTIALLY_FILLED_ENTRY_WITHOUT_PROTECTED_EXIT",
                                        })
                                        unresolved.append(row["list_client_order_id"])
                                    else:
                                        self.storage.update_testnet_auto_order(row["list_client_order_id"], {
                                            "status": "NOT_FILLED", "error_code": None,
                                        })
                                        canceled.append(row["list_client_order_id"])
                                    continue

                                if working_status in {"open", "pending"} and (self._number(working.get("filled")) or 0.0) > 0:
                                    self.storage.update_testnet_auto_order(row["list_client_order_id"], {
                                        "status": "UNPROTECTED",
                                        "error_code": "PARTIALLY_FILLED_WORKING_ORDER_HAS_NO_ACTIVE_OPOCO_EXITS",
                                    })
                                    unresolved.append(row["list_client_order_id"])
                                    continue
                                if working_status not in {"open", "pending"}:
                                    unresolved.append(row["list_client_order_id"])
                                    continue
                            exchange.request("orderList", "private", "DELETE", {
                                "symbol": row["symbol"].replace("/", ""),
                                "orderListId": list_id,
                            })
                            self.storage.update_testnet_auto_order(row["list_client_order_id"], {
                                "status": "CANCELED", "error_code": None,
                            })
                            canceled.append(row["list_client_order_id"])
                        except Exception:
                            self.storage.update_testnet_auto_order(row["list_client_order_id"], {
                                "status": "UNKNOWN", "error_code": "CANCEL_OR_RECONCILIATION_UNCERTAIN",
                            })
                            unresolved.append(row["list_client_order_id"])
                except Exception:
                    unresolved.extend(row["list_client_order_id"] for row in rows)
            if exchange is not None:
                self.adapter._close(exchange)
            return {
                "halted": True,
                "new_auto_entries_disabled": True,
                "canceled_unfilled_order_lists": canceled,
                # Retain the old response keys consumed by existing API clients/tests.
                "canceled_order_lists": canceled,
                "completed_order_lists": completed,
                "protection_preserved_for_filled_entries": protected,
                "unresolved_order_lists": unresolved,
                "live_trading_enabled": False,
            }
