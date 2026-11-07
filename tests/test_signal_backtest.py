import math
import random

from app.services.backtest import run_signal_backtest, run_signal_walk_forward


def _candles(count, step_ms, start_ms, *, drift, amplitude, noise, seed):
    rng = random.Random(seed)
    rows = []
    previous = 100.0
    for index in range(count):
        close = 100.0 + drift * index + amplitude * math.sin(index / 8.0) + rng.gauss(0, noise)
        open_price = previous
        high = max(open_price, close) + 0.1
        low = max(0.01, min(open_price, close) - 0.1)
        volume = 1000.0 + rng.random() * 500.0
        rows.append([start_ms + index * step_ms, open_price, high, low, close, volume])
        previous = close
    return rows


def _history():
    primary = _candles(300, 3_600_000, 0, drift=0.045, amplitude=1.2, noise=0.3, seed=7)
    # The higher series starts before the primary window so 150 complete 4h bars
    # are available without using candles that close in the future.
    higher = _candles(180, 14_400_000, -420 * 3_600_000,
                      drift=0.18, amplitude=2.4, noise=0.5, seed=8)
    return primary, higher


def test_signal_backtest_uses_same_primary_and_higher_timeframe_setup():
    primary, higher = _history()
    result = run_signal_backtest(primary, higher)
    assert result["mode"] == "historical_research_only"
    assert result["strategy"].startswith("EMA20/50 + Wilder")
    assert result["signals_evaluated"] > 0
    assert result["eligible_strategy_signals"] >= result["entries"]
    assert result["max_drawdown_pct"] >= 0
    assert result["closed_trades"] >= 0
    assert "benchmark_net_return_pct" in result
    assert "excess_return_vs_benchmark_pct" in result
    assert 0 <= result["time_in_market_pct"] <= 100
    assert "four-bar" in result["execution_model"]
    assert "bid/ask spread" in " ".join(result["scope_limitations"])


def test_signal_backtest_does_not_use_future_higher_timeframe_candles():
    primary, higher = _history()
    baseline = run_signal_backtest(primary, higher)
    future_row = [primary[-1][0] + 3_600_000, 1.0, 1.1, 0.9, 1.0, 100.0]
    with_future = run_signal_backtest(primary, higher + [future_row])
    assert with_future["net_return_pct"] == baseline["net_return_pct"]
    assert with_future["entries"] == baseline["entries"]


def test_signal_walk_forward_uses_chronological_non_overlapping_windows():
    primary, higher = _history()
    result = run_signal_walk_forward(primary, higher, folds=3)
    assert result["total_folds"] == 3
    assert len(result["folds"]) == 3
    assert result["folds"][0]["test_end_timestamp_ms"] < result["folds"][1]["test_start_timestamp_ms"]
    assert [row["cost_multiplier"] for row in result["cost_stress"]] == [1.0, 1.5, 2.0]
    assert "not proof" in result["warning"]


def test_signal_backtest_fails_closed_when_primary_history_has_missing_bars():
    import pytest

    primary, higher = _history()
    del primary[210]
    with pytest.raises(ValueError, match="missing/off-grid candle intervals"):
        run_signal_backtest(primary, higher)


def test_signal_backtest_rejects_unviable_net_reward_to_risk_after_costs():
    import pytest

    primary, higher = _history()
    with pytest.raises(ValueError, match="net reward/risk"):
        run_signal_backtest(primary, higher, take_profit_pct=1.5)


def test_signal_backtest_rejects_duplicate_or_off_grid_raw_candles():
    import pytest

    primary, higher = _history()
    primary[220] = primary[219].copy()
    with pytest.raises(ValueError, match="duplicate|off-grid|invalid"):
        run_signal_backtest(primary, higher)

    primary, higher = _history()
    primary[220][0] += 5_000
    with pytest.raises(ValueError, match="duplicate|off-grid|invalid"):
        run_signal_backtest(primary, higher)


def test_signal_backtest_checks_stop_and_target_on_entry_candle(monkeypatch):
    import app.services.strategy as strategy

    primary, _ = _history()
    higher = _candles(220, 14_400_000, -600 * 3_600_000,
                      drift=0.18, amplitude=2.4, noise=0.5, seed=8)
    # At the next bar open, the signal is known from fully closed prior candles.
    # This bar touches both stop and target. The conservative rule must take the stop.
    primary[151] = [primary[151][0], 100.0, 105.0, 95.0, 101.0, 1500.0]

    def one_entry_signal(candles, bars_per_day=24.0):
        if bars_per_day == 6.0:
            return {"signal": "HOLD", "regime": "UPTREND", "atr_pct": 1.0,
                    "rsi14": 55.0, "adx14": 25.0, "plus_di14": 30.0, "minus_di14": 10.0}
        if len(candles) == 151:
            return {"signal": "BUY_CANDIDATE", "regime": "UPTREND", "atr_pct": 1.0,
                    "rsi14": 55.0, "adx14": 25.0, "plus_di14": 30.0, "minus_di14": 10.0}
        return {"signal": "HOLD", "regime": "RANGE_OR_TRANSITION", "atr_pct": 1.0,
                "rsi14": 50.0, "adx14": 10.0, "plus_di14": 10.0, "minus_di14": 10.0}

    monkeypatch.setattr(strategy, "analyze_candles", one_entry_signal)
    result = run_signal_backtest(primary, higher, start_index=150)
    assert result["entries"] == 1
    assert result["closed_trades"] == 1
    assert result["forced_end_liquidation"] is False
    assert result["average_holding_bars"] == 1
    assert result["net_return_pct"] < 0
    assert "including the entry candle" in result["execution_model"]
