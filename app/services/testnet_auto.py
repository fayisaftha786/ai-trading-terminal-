from __future__ import annotations

import hashlib
import threading
from datetime import datetime, timezone
from math import isfinite
from typing import Any

from app.services.risk import RiskRejected, validate_risk_profile
from app.services.testnet import BinanceSpotTestnet, TestnetUnavailable


class TestnetAutoTrader:
    """Signal-driven Binance Spot Testnet execution with exchange-native OTOCO protection."""

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

    def status(self, entry_enabled: bool) -> dict[str, Any]:
        halted = bool(self.storage.get_setting("testnet_order_halted", False))
        adapter_status = self.adapter.status(halted=halted)
        active = self.storage.list_active_testnet_auto_orders()
        return {
            "enabled": bool(entry_enabled),
            "mode": "testnet_only",
            "provider": "Binance Spot Testnet",
            "order_execution_enabled": bool(adapter_status["order_execution_enabled"]),
            "emergency_halted": halted,
            "active_order_lists": len(active),
            "max_entries_per_day": self.MAX_ENTRIES_PER_DAY,
            "protection": "Binance native OPOCO (net received BUY quantity + take-profit/stop-loss OCO)",
            "live_trading_enabled": False,
        }

    def _reconcile_locked(self) -> dict[str, int]:
        rows = self.storage.list_active_testnet_auto_orders()
        counts = {"checked": 0, "executing": 0, "completed": 0, "unresolved": 0}
        if not rows:
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
                        raise ValueError("OTOCO working order ID is unavailable")
                    working = exchange.fetch_order(working_id, row["symbol"])
                    working_status = str(working.get("status") or "unknown").lower()

                    if working_status in {"canceled", "cancelled", "expired", "rejected"}:
                        self.storage.update_testnet_auto_order(row["list_client_order_id"], {
                            "working_order_id": str(working_id),
                            "status": "NOT_FILLED",
                            "error_code": None,
                        })
                        counts["completed"] += 1
                        continue

                    if working_status == "closed":
                        exit_ids = [
                            item.get("orderId") for item in orders
                            if str(item.get("orderId")) != str(working_id) and item.get("orderId") is not None
                        ]
                        exit_states = []
                        for order_id in exit_ids:
                            try:
                                exit_order = exchange.fetch_order(order_id, row["symbol"])
                                exit_states.append(str(exit_order.get("status") or "unknown").lower())
                            except Exception:
                                exit_states.append("unknown")
                        if "closed" in exit_states:
                            self.storage.update_testnet_auto_order(row["list_client_order_id"], {
                                "working_order_id": str(working_id),
                                "status": "CLOSED",
                                "error_code": None,
                            })
                            counts["completed"] += 1
                        elif list_status == "EXECUTING" or any(state in {"open", "pending"} for state in exit_states):
                            self.storage.update_testnet_auto_order(row["list_client_order_id"], {
                                "working_order_id": str(working_id),
                                "status": "EXECUTING",
                                "error_code": None,
                            })
                            counts["executing"] += 1
                        else:
                            # The entry filled but no live protective exit can be confirmed.
                            # Keep it active and block new entries until a human reconciles it.
                            self.storage.update_testnet_auto_order(row["list_client_order_id"], {
                                "working_order_id": str(working_id),
                                "status": "UNPROTECTED",
                                "error_code": "FILLED_ENTRY_WITHOUT_CONFIRMED_EXIT",
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
        candle_stamp = ticker.get("timestamp") or item.get("last_closed_candle_timestamp_ms") or "unknown"
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
                                    exit_ids = [
                                        item.get("orderId") for item in child_orders
                                        if str(item.get("orderId")) != str(working_id) and item.get("orderId") is not None
                                    ]
                                    exit_states = []
                                    for order_id in exit_ids:
                                        exit_order = exchange.fetch_order(order_id, row["symbol"])
                                        exit_states.append(str(exit_order.get("status") or "unknown").lower())
                                    if "closed" in exit_states:
                                        self.storage.update_testnet_auto_order(row["list_client_order_id"], {
                                            "status": "CLOSED", "error_code": None,
                                        })
                                        canceled.append(row["list_client_order_id"])
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
                                    self.storage.update_testnet_auto_order(row["list_client_order_id"], {
                                        "status": "NOT_FILLED", "error_code": None,
                                    })
                                    canceled.append(row["list_client_order_id"])
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
                "protection_preserved_for_filled_entries": protected,
                "unresolved_order_lists": unresolved,
                "live_trading_enabled": False,
            }
