from datetime import datetime, timedelta, timezone

from app.services.performance import build_performance_report
from app.storage import Storage


def _trade(trade_id, pnl, *, engine="multi_crypto", closed_at=None, notional=100.0):
    closed_at = closed_at or datetime.now(timezone.utc).isoformat()
    opened_at = (datetime.fromisoformat(closed_at) - timedelta(hours=1)).isoformat()
    return {
        "id": trade_id,
        "engine": engine,
        "symbol": f"TEST{trade_id}/USDT",
        "status": "CLOSED",
        "opened_at": opened_at,
        "closed_at": closed_at,
        "notional_usd": notional,
        "pnl_usd": pnl,
    }


def test_performance_report_net_metrics_and_drawdown_are_correct():
    now = datetime.now(timezone.utc)
    trades = [
        _trade(1, 5.0, closed_at=(now - timedelta(days=3)).isoformat()),
        _trade(2, -2.0, closed_at=(now - timedelta(days=2)).isoformat()),
        _trade(3, 1.0, engine="solana", closed_at=(now - timedelta(days=1)).isoformat()),
        _trade(4, 0.0, closed_at=now.isoformat()),
    ]
    report = build_performance_report(trades, 100.0, 30, now=now)
    metrics = report["metrics"]
    assert metrics["closed_trades"] == 4
    assert metrics["winning_trades"] == 2
    assert metrics["losing_trades"] == 1
    assert metrics["breakeven_trades"] == 1
    assert metrics["win_rate_pct"] == 50.0
    assert metrics["net_pnl_usd"] == 4.0
    assert metrics["profit_factor"] == 3.0
    assert metrics["expectancy_usd_per_trade"] == 1.0
    assert report["by_engine"]["solana"]["closed_trades"] == 1
    assert report["by_engine"]["multi_crypto"]["closed_trades"] == 3
    assert report["all_time_realized_max_drawdown_pct"] == 1.904762
    assert report["sample_status"] == "insufficient_sample"


def test_performance_report_does_not_claim_infinite_profit_factor_without_losses():
    now = datetime.now(timezone.utc)
    report = build_performance_report([_trade(1, 2.5)], 100.0, 30, now=now)
    assert report["metrics"]["profit_factor"] is None
    assert report["metrics"]["profit_factor_status"] == "no_losses_in_sample"


def test_performance_report_excludes_open_trades_and_old_period_trades():
    now = datetime.now(timezone.utc)
    old = _trade(1, 50.0, closed_at=(now - timedelta(days=60)).isoformat())
    open_trade = _trade(2, 20.0, closed_at=now.isoformat())
    open_trade["status"] = "OPEN"
    report = build_performance_report([old, open_trade], 100.0, 30, now=now)
    assert report["metrics"]["closed_trades"] == 0
    assert report["metrics"]["net_pnl_usd"] == 0
    assert report["all_time_closed_trade_count_in_report"] == 1


def test_equity_snapshots_require_complete_marks_and_upsert_per_minute(tmp_path):
    db = Storage(tmp_path / "snapshots.db")
    db.initialize(100.0)
    base = datetime(2026, 11, 6, 12, 30, 1, tzinfo=timezone.utc)
    assert not db.record_equity_snapshot({"unmarked_positions": 1}, base)
    sample = {
        "equity_usd": 101.0,
        "realized_pnl_usd": 0.0,
        "unrealized_pnl_usd": 1.0,
        "open_positions": 1,
        "drawdown_pct_from_peak": 0.0,
        "unmarked_positions": 0,
    }
    assert db.record_equity_snapshot(sample, base)
    sample["equity_usd"] = 102.0
    assert db.record_equity_snapshot(sample, base + timedelta(seconds=45))
    rows = db.list_equity_snapshots("2026-11-06T12:00:00+00:00")
    assert len(rows) == 1
    assert rows[0]["equity_usd"] == 102.0
