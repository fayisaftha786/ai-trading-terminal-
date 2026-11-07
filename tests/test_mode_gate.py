from app.services.mode_gate import assess_demo_readiness


def qualified_report():
    return {
        "metrics": {
            "closed_trades": 35,
            "net_pnl_usd": 42.5,
            "profit_factor": 1.35,
        },
        "max_observed_marked_drawdown_pct": 3.2,
        "equity_snapshot_count": 25,
    }


def test_demo_qualification_does_not_enable_live_orders():
    result = assess_demo_readiness(
        qualified_report(),
        auto_demo_enabled=True,
        open_positions=0,
        production_executor_enabled=False,
    )
    assert result["demo"]["qualified_for_live_review"] is True
    assert result["original"]["available"] is False
    assert result["original"]["enabled"] is False
    assert result["original"]["automatic_promotion"] is False
    assert result["safety"]["real_orders_sent"] is False


def test_demo_gate_fails_closed_when_any_evidence_is_missing():
    report = qualified_report()
    report["max_observed_marked_drawdown_pct"] = None
    result = assess_demo_readiness(
        report, auto_demo_enabled=True, open_positions=0
    )
    assert result["demo"]["qualified_for_live_review"] is False
    assert result["demo"]["checks"]["drawdown_within_limit"] is False


def test_open_demo_positions_block_promotion():
    result = assess_demo_readiness(
        qualified_report(), auto_demo_enabled=True, open_positions=1
    )
    assert result["demo"]["qualified_for_live_review"] is False
    assert result["demo"]["checks"]["no_open_demo_positions"] is False


def test_demo_requires_minimum_trade_count_profit_factor_and_snapshots():
    report = qualified_report()
    report["metrics"]["closed_trades"] = 29
    report["metrics"]["profit_factor"] = 1.1
    report["equity_snapshot_count"] = 9
    result = assess_demo_readiness(
        report, auto_demo_enabled=True, open_positions=0
    )
    assert result["demo"]["qualified_for_live_review"] is False
    assert result["demo"]["checks"]["minimum_closed_trades"] is False
    assert result["demo"]["checks"]["minimum_profit_factor"] is False
    assert result["demo"]["checks"]["verified_equity_history"] is False
