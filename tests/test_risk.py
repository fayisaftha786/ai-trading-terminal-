import pytest

from app.services.risk import RiskRejected, size_position
from app.storage import DEFAULT_RISK


def test_position_size_respects_risk_and_exposure():
    sized = size_position(capital=100, current_exposure=0, open_positions=0,
                          requested_notional=100, price=10, risk=DEFAULT_RISK)
    # Stop risk now includes round-trip fees and slippage, not just the chart stop.
    assert sized["notional_usd"] == pytest.approx(0.25 / 0.014)
    assert sized["estimated_stop_loss_usd"] == pytest.approx(0.25)


def test_position_count_blocks_new_trade():
    with pytest.raises(RiskRejected, match="Maximum"):
        size_position(capital=100, current_exposure=0, open_positions=3,
                      requested_notional=10, price=1, risk=DEFAULT_RISK)


def test_exposure_exhaustion_blocks_trade():
    with pytest.raises(RiskRejected, match="exposure"):
        size_position(capital=100, current_exposure=20, open_positions=0,
                      requested_notional=5, price=1, risk=DEFAULT_RISK)


def test_daily_loss_guard_blocks_new_order():
    risk = dict(DEFAULT_RISK)
    with pytest.raises(RiskRejected, match="Daily"):
        size_position(capital=100, current_exposure=0, open_positions=0,
                      requested_notional=5, price=1, risk=risk, daily_realized_pnl=-1.5)


def test_weekly_loss_guard_blocks_new_order():
    risk = dict(DEFAULT_RISK)
    with pytest.raises(RiskRejected, match="Weekly"):
        size_position(capital=100, current_exposure=0, open_positions=0,
                      requested_notional=5, price=1, risk=risk, weekly_realized_pnl=-4.0)


def test_position_sizing_rejects_non_finite_inputs():
    from app.services.risk import RiskRejected, size_position
    from app.storage import DEFAULT_RISK

    with pytest.raises(RiskRejected, match="finite"):
        size_position(
            capital=100, current_exposure=0, open_positions=0,
            requested_notional=None, price=float("inf"), risk=dict(DEFAULT_RISK),
        )


def test_position_sizing_includes_round_trip_cost_in_stop_risk():
    sized = size_position(capital=100, current_exposure=0, open_positions=0,
                          requested_notional=100, price=10, risk=DEFAULT_RISK)
    assert sized["estimated_stop_loss_usd"] == pytest.approx(0.25)
    assert sized["effective_stop_rate_pct"] == pytest.approx(1.4)


def test_risk_profile_rejects_corrupt_or_non_finite_persisted_values():
    risk = dict(DEFAULT_RISK)
    risk["max_total_exposure_pct"] = float("inf")
    with pytest.raises(RiskRejected, match="safe limits"):
        size_position(capital=100, current_exposure=0, open_positions=0,
                      requested_notional=5, price=1, risk=risk)


def test_risk_profile_rejects_target_that_does_not_cover_round_trip_costs():
    risk = dict(DEFAULT_RISK)
    risk["take_profit_pct"] = 1.5
    with pytest.raises(RiskRejected, match="net reward/risk"):
        size_position(capital=100, current_exposure=0, open_positions=0,
                      requested_notional=5, price=1, risk=risk)


def test_invalid_fee_or_slippage_uses_conservative_exit_cost_caps():
    from app.services.risk import safe_cost_assumptions

    fee, slippage = safe_cost_assumptions({"fee_bps_per_side": float("inf"), "slippage_bps": -1})
    assert fee == 100.0
    assert slippage == 200.0


def test_spread_is_included_in_automatic_entry_stop_risk_budget():
    base = size_position(capital=100, current_exposure=0, open_positions=0,
                         requested_notional=100, price=100, risk=DEFAULT_RISK)
    with_spread = size_position(capital=100, current_exposure=0, open_positions=0,
                                requested_notional=100, price=100, risk=DEFAULT_RISK,
                                extra_round_trip_cost_bps=25)
    assert with_spread["notional_usd"] < base["notional_usd"]
    assert with_spread["estimated_stop_loss_usd"] == pytest.approx(0.25)
    assert with_spread["effective_stop_rate_pct"] == pytest.approx(1.65)


def test_incomplete_peak_equity_pair_is_rejected():
    with pytest.raises(RiskRejected, match="supplied together"):
        size_position(capital=100, current_exposure=0, open_positions=0,
                      requested_notional=5, price=1, risk=DEFAULT_RISK,
                      current_equity=100)
