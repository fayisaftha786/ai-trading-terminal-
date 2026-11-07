from __future__ import annotations

from math import isfinite
from typing import Any


MIN_DEMO_CLOSED_TRADES = 30
MIN_DEMO_PROFIT_FACTOR = 1.20
MAX_DEMO_DRAWDOWN_PCT = 5.0
MIN_DEMO_EQUITY_SNAPSHOTS = 10


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if isfinite(number) else None


def assess_demo_readiness(
    report: dict[str, Any],
    *,
    auto_demo_enabled: bool,
    open_positions: int,
    production_executor_enabled: bool = False,
) -> dict[str, Any]:
    """Assess whether paper evidence is sufficient to request a separate live-mode review.

    Passing this gate never enables production orders. Live activation remains a separate,
    explicit user action and requires a production executor, credentials and risk controls.
    """
    metrics = report.get("metrics") or {}
    closed = int(metrics.get("closed_trades") or 0)
    net_pnl = _number(metrics.get("net_pnl_usd"))
    profit_factor = _number(metrics.get("profit_factor"))
    drawdown = _number(report.get("max_observed_marked_drawdown_pct"))
    snapshots = int(report.get("equity_snapshot_count") or 0)
    checks = {
        "minimum_closed_trades": closed >= MIN_DEMO_CLOSED_TRADES,
        "positive_net_pnl_after_costs": net_pnl is not None and net_pnl > 0,
        "minimum_profit_factor": profit_factor is not None and profit_factor >= MIN_DEMO_PROFIT_FACTOR,
        "drawdown_within_limit": drawdown is not None and drawdown <= MAX_DEMO_DRAWDOWN_PCT,
        "verified_equity_history": snapshots >= MIN_DEMO_EQUITY_SNAPSHOTS,
        "no_open_demo_positions": int(open_positions) == 0,
        "demo_automation_enabled": bool(auto_demo_enabled),
    }
    qualified = all(checks.values())
    live_ready = qualified and bool(production_executor_enabled)
    return {
        "demo": {
            "mode": "DEMO",
            "automation_enabled": bool(auto_demo_enabled),
            "qualification": "qualified_for_live_review" if qualified else "in_progress",
            "qualified_for_live_review": qualified,
            "checks": checks,
            "observed": {
                "closed_trades": closed,
                "net_pnl_usd": net_pnl,
                "profit_factor": profit_factor,
                "max_observed_marked_drawdown_pct": drawdown,
                "equity_snapshot_count": snapshots,
                "open_positions": int(open_positions),
            },
            "thresholds": {
                "minimum_closed_trades": MIN_DEMO_CLOSED_TRADES,
                "minimum_profit_factor": MIN_DEMO_PROFIT_FACTOR,
                "maximum_drawdown_pct": MAX_DEMO_DRAWDOWN_PCT,
                "minimum_equity_snapshots": MIN_DEMO_EQUITY_SNAPSHOTS,
            },
        },
        "original": {
            "mode": "ORIGINAL_LIVE",
            "available": live_ready,
            "enabled": False,
            "locked": True,
            "reason": (
                "Production order executor is not implemented/enabled in this build."
                if not production_executor_enabled else
                "Live trading requires a separate explicit confirmation and risk review."
            ),
            "automatic_promotion": False,
            "requires_explicit_user_confirmation": True,
        },
        "safety": {
            "real_orders_sent": False,
            "demo_and_live_ledgers_separate": True,
            "demo_success_never_automatically_moves_real_funds": True,
        },
    }
