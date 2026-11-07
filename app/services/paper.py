from __future__ import annotations

import json
import sqlite3
import threading
from math import isfinite
from datetime import datetime, timezone
from typing import Any

from app.storage import Storage
from app.services.risk import RiskRejected, safe_cost_assumptions, size_position, validate_risk_profile


class PaperBroker:
    def __init__(self, db: Storage):
        self.db = db
        # This app is intentionally a single-worker local backend. Serialize allocation
        # across manual API entries and background strategy scans so two different symbols
        # cannot both size against the same pre-trade portfolio snapshot.
        self._entry_lock = threading.RLock()

    def open_long(self, request: dict[str, Any]) -> dict[str, Any]:
        with self._entry_lock:
            return self._open_long_locked(request)

    def _open_long_locked(self, request: dict[str, Any]) -> dict[str, Any]:
        engine = str(request["engine"])
        symbol = str(request["symbol"])
        if self.db.has_open_trade(engine, symbol):
            raise RiskRejected("An open position already exists for this market")
        risk = validate_risk_profile(self.db.get_risk())
        marks = request.get("_portfolio_marks")
        summary = self.db.portfolio_summary(
            marks if isinstance(marks, dict) else None,
            fee_bps_per_side=float(risk["fee_bps_per_side"]),
            slippage_bps=float(risk["slippage_bps"]),
        )
        slippage_rate = float(risk["slippage_bps"]) / 10_000
        simulated_entry_price = float(request["price_usd"]) * (1 + slippage_rate)
        sized = size_position(
            capital=float(summary["equity_usd"]),
            current_exposure=float(summary["exposure_usd"]),
            open_positions=int(summary["open_positions"]),
            requested_notional=request.get("requested_notional_usd"),
            price=simulated_entry_price,
            risk=risk,
            daily_realized_pnl=float(summary["daily_realized_pnl_usd"]),
            weekly_realized_pnl=float(summary["weekly_realized_pnl_usd"]),
            daily_equity_pnl=summary.get("daily_equity_pnl_usd"),
            weekly_equity_pnl=summary.get("weekly_equity_pnl_usd"),
            current_equity=float(summary["equity_usd"]),
            peak_equity=float(summary["peak_equity_usd"]),
            unmarked_positions=int(summary["unmarked_positions"]),
            extra_round_trip_cost_bps=float(request.get("_entry_spread_bps", 0.0)),
        )
        fee_rate = float(risk["fee_bps_per_side"]) / 10_000
        entry = simulated_entry_price
        quantity = sized["quantity"]
        notional = entry * quantity
        entry_fee = notional * fee_rate
        stop = entry * (1 - float(risk["stop_loss_pct"]) / 100)
        target = entry * (1 + float(risk["take_profit_pct"]) / 100)
        metadata = {"mode": "paper", "entry_slippage_bps": risk["slippage_bps"],
                    "fee_bps_per_side": risk["fee_bps_per_side"],
                    "risk_budget_usd": sized["risk_budget_usd"],
                    "estimated_stop_loss_usd": sized["estimated_stop_loss_usd"],
                    "entry_spread_bps": float(request.get("_entry_spread_bps", 0.0)),
                    "automation": request.get("automation", False),
                    "signal": request.get("signal_metadata", {})}
        try:
            with self.db.connection() as conn:
                cursor = conn.execute(
                    "INSERT INTO trades(engine,symbol,name,mint,side,status,entry_price,quantity,notional_usd,"
                    "stop_loss,take_profit,fees_usd,metadata_json) VALUES(?,?,?,?, 'BUY','OPEN',?,?,?,?,?,?,?)",
                    (request["engine"], request["symbol"], request.get("name", ""), request.get("mint", ""),
                     entry, quantity, notional, stop, target, entry_fee, json.dumps(metadata)),
                )
                trade_id = cursor.lastrowid
        except sqlite3.IntegrityError as exc:
            # The partial unique index is the final concurrency-safe duplicate guard.
            if self.db.has_open_trade(engine, symbol):
                raise RiskRejected("An open position already exists for this market") from exc
            raise
        trade = next(t for t in self.db.list_trades(100) if t["id"] == trade_id)
        self.db.log_event("paper_order_opened", f"Paper BUY {trade['symbol']} opened", {"trade_id": trade_id})
        return trade

    def close(self, trade_id: int, mark_price: float, reason: str = "manual") -> dict[str, Any]:
        if not isfinite(float(mark_price)) or mark_price <= 0:
            raise ValueError("Exit price must be a finite positive number")
        # Closing must remain possible even when an unrelated persisted risk field
        # is corrupt. Invalid fee/slippage values fall back to conservative caps.
        fee_bps, slippage_bps = safe_cost_assumptions(self.db.get_risk())
        with self.db.connection() as conn:
            # Acquire the SQLite write reservation before reading the row so two
            # close requests cannot both calculate and publish a close fill.
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT * FROM trades WHERE id=?", (trade_id,)).fetchone()
            if row is None:
                raise ValueError("Paper trade not found")
            if row["status"] != "OPEN":
                raise ValueError("Paper trade is already closed")
            slip = slippage_bps / 10_000
            fee_rate = fee_bps / 10_000
            exit_price = float(mark_price) * (1 - slip)
            gross = (exit_price - float(row["entry_price"])) * float(row["quantity"])
            exit_fee = exit_price * float(row["quantity"]) * fee_rate
            entry_fee = float(row["fees_usd"])
            net_pnl = gross - exit_fee - entry_fee
            try:
                metadata = json.loads(row["metadata_json"] or "{}")
                if not isinstance(metadata, dict):
                    metadata = {}
            except (TypeError, ValueError, json.JSONDecodeError):
                # Corrupt auxiliary metadata must never prevent an emergency paper exit.
                metadata = {"metadata_recovered": True}
            metadata["close_reason"] = str(reason)[:120]
            metadata["close_reference_price"] = float(mark_price)
            cursor = conn.execute(
                "UPDATE trades SET status='CLOSED',closed_at=?,exit_price=?,fees_usd=?,pnl_usd=?,metadata_json=? "
                "WHERE id=? AND status='OPEN'",
                (datetime.now(timezone.utc).isoformat(), exit_price, entry_fee + exit_fee, net_pnl,
                 json.dumps(metadata), trade_id),
            )
            if cursor.rowcount != 1:
                raise ValueError("Paper trade was already closed by another action")
        self.db.log_event("paper_order_closed", f"Paper position {trade_id} closed: {reason}",
                          {"trade_id": trade_id, "net_pnl_usd": net_pnl, "reason": reason})
        return next(t for t in self.db.list_trades(200) if t["id"] == trade_id)

    def mark_and_close_triggers(self, marks: dict[str, float]) -> list[dict[str, Any]]:
        closed = []
        for trade in self.db.open_trades():
            price = marks.get(trade["symbol"])
            if price is None:
                continue
            if price <= trade["stop_loss"]:
                # A stop-market exit may gap through its stop; value it at the observed
                # executable bid, then apply the configured exit slippage.
                closed.append(self.close(trade["id"], price, "stop_loss"))
            elif price >= trade["take_profit"]:
                # Do not award favorable price improvement above the target in a paper
                # simulation. The backtest also assumes a target-price fill before costs.
                closed.append(self.close(trade["id"], float(trade["take_profit"]), "take_profit"))
        return closed
