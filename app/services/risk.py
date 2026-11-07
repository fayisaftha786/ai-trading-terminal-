from __future__ import annotations

from math import isfinite
from typing import Any


class RiskRejected(ValueError):
    pass


RISK_BOUNDS = {
    "risk_per_trade_pct": (0.05, 1.0),
    "max_daily_loss_pct": (0.25, 5.0),
    "max_weekly_loss_pct": (0.5, 10.0),
    "max_total_exposure_pct": (1.0, 50.0),
    "stop_loss_pct": (0.25, 10.0),
    "take_profit_pct": (0.5, 30.0),
    "fee_bps_per_side": (0.0, 100.0),
    "slippage_bps": (0.0, 200.0),
    "max_total_drawdown_pct": (1.0, 20.0),
}


def safe_cost_assumptions(risk: dict[str, Any]) -> tuple[float, float]:
    """Return bounded fee/slippage bps for valuation and exits even if other risk data is corrupt."""
    result: list[float] = []
    for name, maximum in (("fee_bps_per_side", 100.0), ("slippage_bps", 200.0)):
        try:
            value = float(risk[name])
        except (KeyError, TypeError, ValueError, OverflowError):
            value = maximum
        if not isfinite(value) or value < 0 or value > maximum:
            value = maximum
        result.append(value)
    return result[0], result[1]


def validate_risk_profile(risk: dict[str, Any]) -> dict[str, float | int]:
    """Validate persisted as well as API-supplied risk settings before sizing."""
    validated: dict[str, float | int] = {}
    for name, (minimum, maximum) in RISK_BOUNDS.items():
        try:
            value = float(risk[name])
        except (KeyError, TypeError, ValueError, OverflowError):
            raise RiskRejected(f"Risk profile is missing or invalid: {name}") from None
        if not isfinite(value) or value < minimum or value > maximum:
            raise RiskRejected(f"Risk profile value is outside safe limits: {name}")
        validated[name] = value
    try:
        positions = int(risk["max_open_positions"])
    except (KeyError, TypeError, ValueError, OverflowError):
        raise RiskRejected("Risk profile is missing or invalid: max_open_positions") from None
    if positions < 1 or positions > 5 or float(risk["max_open_positions"]) != positions:
        raise RiskRejected("Risk profile value is outside safe limits: max_open_positions")
    validated["max_open_positions"] = positions
    # Require at least 1:1 net reward/risk after estimated round-trip fees and slippage.
    round_trip_cost_pct = 2.0 * (validated["fee_bps_per_side"] + validated["slippage_bps"]) / 100.0
    minimum_target_pct = validated["stop_loss_pct"] + 2.0 * round_trip_cost_pct
    if validated["take_profit_pct"] < minimum_target_pct:
        raise RiskRejected(
            "Take-profit is too small for the stop distance and estimated round-trip costs; "
            "net reward/risk must be at least 1:1"
        )
    return validated


def size_position(
    *, capital: float, current_exposure: float, open_positions: int,
    requested_notional: float | None, price: float, risk: dict[str, Any],
    daily_realized_pnl: float = 0.0, weekly_realized_pnl: float = 0.0,
    daily_equity_pnl: float | None = None, weekly_equity_pnl: float | None = None,
    current_equity: float | None = None, initial_capital: float | None = None,
    peak_equity: float | None = None, unmarked_positions: int = 0,
    extra_round_trip_cost_bps: float = 0.0,
) -> dict[str, float]:
    core_values = (capital, price, current_exposure, daily_realized_pnl, weekly_realized_pnl,
                   extra_round_trip_cost_bps)
    try:
        valid_core = all(isfinite(float(value)) for value in core_values)
    except (TypeError, ValueError, OverflowError):
        valid_core = False
    if not valid_core:
        raise RiskRejected("Risk inputs must be finite numbers")
    profile = validate_risk_profile(risk)
    if capital <= 0 or price <= 0 or current_exposure < 0:
        raise RiskRejected("Capital and price must be positive and exposure cannot be negative")
    if extra_round_trip_cost_bps < 0 or extra_round_trip_cost_bps > 100:
        raise RiskRejected("Additional round-trip execution cost must be between 0 and 100 bps")
    if (current_equity is None) != (peak_equity is None):
        raise RiskRejected("Current equity and peak equity must be supplied together")
    if requested_notional is not None and (not isfinite(float(requested_notional)) or requested_notional <= 0):
        raise RiskRejected("Requested notional must be a finite positive number")
    daily_loss_value = daily_equity_pnl if daily_equity_pnl is not None else daily_realized_pnl
    weekly_loss_value = weekly_equity_pnl if weekly_equity_pnl is not None else weekly_realized_pnl
    if not isfinite(float(daily_loss_value)) or not isfinite(float(weekly_loss_value)):
        raise RiskRejected("Daily/weekly equity-loss observations must be finite")
    if daily_loss_value <= -(capital * profile["max_daily_loss_pct"] / 100):
        raise RiskRejected("Daily net-equity loss limit reached; new paper orders are blocked")
    if weekly_loss_value <= -(capital * profile["max_weekly_loss_pct"] / 100):
        raise RiskRejected("Weekly net-equity loss limit reached; new paper orders are blocked")
    if unmarked_positions > 0:
        raise RiskRejected("Open positions have no fresh market mark; new automatic paper entries are blocked")
    if current_equity is not None and peak_equity is not None and peak_equity > 0:
        if not isfinite(float(current_equity)) or not isfinite(float(peak_equity)):
            raise RiskRejected("Current and peak equity must be finite")
        drawdown_pct = max(0.0, (peak_equity - current_equity) / peak_equity * 100)
        if drawdown_pct >= profile["max_total_drawdown_pct"]:
            raise RiskRejected("Total portfolio drawdown limit reached; new paper orders are blocked")
    if open_positions >= profile["max_open_positions"]:
        raise RiskRejected("Maximum open-position count reached")
    max_exposure = capital * profile["max_total_exposure_pct"] / 100
    remaining_exposure = max_exposure - current_exposure
    risk_budget = capital * profile["risk_per_trade_pct"] / 100
    stop_rate = profile["stop_loss_pct"] / 100
    # Budget for the stop move plus both sides' estimated fees and slippage.
    round_trip_cost_rate = (
        2.0 * (profile["fee_bps_per_side"] + profile["slippage_bps"])
        + extra_round_trip_cost_bps
    ) / 10_000
    effective_stop_rate = stop_rate + round_trip_cost_rate
    risk_limited_notional = risk_budget / effective_stop_rate
    requested = requested_notional if requested_notional is not None else max_exposure
    allowed = min(float(requested), remaining_exposure, risk_limited_notional)
    if allowed <= 0:
        raise RiskRejected("Risk or exposure budget is exhausted")
    return {
        "notional_usd": round(allowed, 8),
        "quantity": allowed / price,
        "risk_budget_usd": risk_budget,
        "estimated_stop_loss_usd": allowed * effective_stop_rate,
        "estimated_stop_loss_pct_of_equity": (allowed * effective_stop_rate / capital * 100),
        "effective_stop_rate_pct": effective_stop_rate * 100,
    }
