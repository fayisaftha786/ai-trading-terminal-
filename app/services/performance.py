from __future__ import annotations

from datetime import datetime, timedelta, timezone
from math import isfinite
from statistics import mean, median
from typing import Any


def _parse_utc(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=timezone.utc)
        return stamp.astimezone(timezone.utc)
    except ValueError:
        return None


def _trade_stats(trades: list[dict[str, Any]]) -> dict[str, Any]:
    pnls: list[float] = []
    returns: list[float] = []
    holding_minutes: list[float] = []
    wins: list[float] = []
    losses: list[float] = []
    win_streak = loss_streak = max_win_streak = max_loss_streak = 0

    for trade in trades:
        try:
            pnl = float(trade.get("pnl_usd"))
            notional = float(trade.get("notional_usd"))
        except (TypeError, ValueError, OverflowError):
            continue
        if not isfinite(pnl) or not isfinite(notional) or notional <= 0:
            continue
        pnls.append(pnl)
        returns.append(pnl / notional * 100)
        if pnl > 0:
            wins.append(pnl)
            win_streak += 1
            loss_streak = 0
        elif pnl < 0:
            losses.append(pnl)
            loss_streak += 1
            win_streak = 0
        else:
            win_streak = loss_streak = 0
        max_win_streak = max(max_win_streak, win_streak)
        max_loss_streak = max(max_loss_streak, loss_streak)

        opened = _parse_utc(trade.get("opened_at"))
        closed = _parse_utc(trade.get("closed_at"))
        if opened and closed and closed >= opened:
            holding_minutes.append((closed - opened).total_seconds() / 60)

    count = len(pnls)
    gross_profit = sum(wins)
    gross_loss = abs(sum(losses))
    profit_factor = gross_profit / gross_loss if gross_loss > 0 else None
    if count == 0:
        pf_status = "no_closed_trades"
    elif gross_loss == 0 and gross_profit > 0:
        pf_status = "no_losses_in_sample"
    elif gross_profit == 0 and gross_loss > 0:
        pf_status = "no_winning_trades"
    else:
        pf_status = "calculated"

    return {
        "closed_trades": count,
        "winning_trades": len(wins),
        "losing_trades": len(losses),
        "breakeven_trades": count - len(wins) - len(losses),
        "win_rate_pct": round(len(wins) / count * 100, 4) if count else None,
        "net_pnl_usd": round(sum(pnls), 8),
        "gross_profit_usd": round(gross_profit, 8),
        "gross_loss_usd": round(gross_loss, 8),
        "profit_factor": round(profit_factor, 6) if profit_factor is not None else None,
        "profit_factor_status": pf_status,
        "expectancy_usd_per_trade": round(mean(pnls), 8) if count else None,
        "average_return_pct_per_trade": round(mean(returns), 6) if count else None,
        "median_pnl_usd": round(median(pnls), 8) if count else None,
        "average_win_usd": round(mean(wins), 8) if wins else None,
        "average_loss_usd": round(mean(losses), 8) if losses else None,
        "max_consecutive_wins": max_win_streak,
        "max_consecutive_losses": max_loss_streak,
        "average_holding_minutes": round(mean(holding_minutes), 2) if holding_minutes else None,
    }


def build_performance_report(
    trades: list[dict[str, Any]],
    initial_capital_usd: float,
    days: int = 30,
    *,
    now: datetime | None = None,
    equity_snapshots: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Summarize realized paper performance; never infer fills or use open P&L as closed trades."""
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    days = max(1, min(int(days), 365))
    cutoff = now - timedelta(days=days)
    normalized: list[tuple[datetime, dict[str, Any]]] = []
    for trade in trades:
        closed_at = _parse_utc(trade.get("closed_at"))
        if closed_at and trade.get("status") == "CLOSED":
            normalized.append((closed_at, trade))
    normalized.sort(key=lambda item: (item[0], int(item[1].get("id", 0) or 0)))
    all_closed = [item[1] for item in normalized]
    period_closed = [trade for stamp, trade in normalized if stamp >= cutoff]

    initial = float(initial_capital_usd)
    equity = initial
    peak = initial
    max_realized_dd = 0.0
    for trade in all_closed:
        try:
            pnl = float(trade.get("pnl_usd"))
        except (TypeError, ValueError, OverflowError):
            continue
        if not isfinite(pnl):
            continue
        equity += pnl
        peak = max(peak, equity)
        if peak > 0:
            max_realized_dd = max(max_realized_dd, (peak - equity) / peak * 100)

    by_engine: dict[str, dict[str, Any]] = {}
    for engine in ("multi_crypto", "solana"):
        by_engine[engine] = _trade_stats([t for t in period_closed if t.get("engine") == engine])

    snapshots = equity_snapshots or []
    valid_snapshots = []
    for row in snapshots:
        stamp = _parse_utc(row.get("created_at"))
        try:
            value = float(row.get("equity_usd"))
        except (TypeError, ValueError, OverflowError):
            continue
        if stamp and stamp >= cutoff and isfinite(value) and value > 0:
            valid_snapshots.append({
                "created_at": stamp.isoformat(),
                "equity_usd": round(value, 8),
                "open_positions": int(row.get("open_positions") or 0),
                "drawdown_pct_from_peak": round(float(row.get("drawdown_pct_from_peak") or 0), 6),
            })
    valid_snapshots.sort(key=lambda row: row["created_at"])
    observed_marked_dd = max(
        (float(row["drawdown_pct_from_peak"]) for row in valid_snapshots),
        default=None,
    )

    count = len(period_closed)
    sample_status = "insufficient_sample" if count < 30 else "early_sample" if count < 100 else "larger_sample_not_a_guarantee"
    return {
        "mode": "paper_only",
        "live_trading_enabled": False,
        "period_days": days,
        "period_start": cutoff.isoformat(),
        "period_end": now.isoformat(),
        "sample_status": sample_status,
        "metrics": _trade_stats(period_closed),
        "by_engine": by_engine,
        "all_time_realized_max_drawdown_pct": round(max_realized_dd, 6),
        "all_time_closed_trade_count_in_report": len(all_closed),
        "equity_snapshots": valid_snapshots,
        "equity_snapshot_count": len(valid_snapshots),
        "max_observed_marked_drawdown_pct": round(observed_marked_dd, 6) if observed_marked_dd is not None else None,
        "equity_snapshot_note": (
            "Snapshots are recorded only when every open paper position has a fresh mark. "
            "No snapshots means no verified marked equity series for this period."
        ),
        "interpretation": (
            "Realized paper-ledger statistics only. This is not live performance, a forecast, "
            "or evidence of future profitability. Small samples are especially unreliable."
        ),
    }
