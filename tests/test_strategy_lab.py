from __future__ import annotations

from app.services import strategy_lab


HOUR_MS = 60 * 60 * 1000
FOUR_HOURS_MS = 4 * HOUR_MS
BASE_MS = 1_700_000_000_000 - (1_700_000_000_000 % FOUR_HOURS_MS)


def _bars(count: int, interval_ms: int, start_ms: int, *, volume: float = 1000.0):
    rows = []
    for index in range(count):
        close = 100.0
        rows.append([
            start_ms + index * interval_ms,
            close,
            close + 0.2,
            close - 0.2,
            close,
            volume,
        ])
    return rows


def _aligned_history(*, breakout: bool = False):
    primary = _bars(300, HOUR_MS, BASE_MS)
    higher = _bars(150, FOUR_HOURS_MS, BASE_MS - 300 * HOUR_MS)
    if breakout:
        for row in primary[-20:]:
            row[5] = 2000.0
        primary[-1] = [
            primary[-1][0], 100.0, 101.5, 99.8, 101.0, 2000.0
        ]
    return primary, higher, BASE_MS + 300 * HOUR_MS


def test_strategy_lab_rejects_gapped_primary_history():
    primary, higher, now_ms = _aligned_history()
    del primary[120]

    result = strategy_lab.evaluate_strategy_candidates(
        primary, higher, higher_interval_ms=FOUR_HOURS_MS, now_ms=now_ms
    )

    assert result["status"] == "blocked"
    assert result["reason"] == "candle_integrity_failed"
    assert result["candidates"] == []
    assert result["execution_authorized"] is False
    assert result["paper_auto_entry_eligible"] is False


def test_strategy_lab_rejects_higher_timeframe_data_from_the_future():
    primary, _, now_ms = _aligned_history()
    # This higher-timeframe window closes four hours after the latest primary bar.
    higher = _bars(150, FOUR_HOURS_MS, BASE_MS - 296 * HOUR_MS)

    result = strategy_lab.evaluate_strategy_candidates(
        primary, higher, higher_interval_ms=FOUR_HOURS_MS, now_ms=now_ms
    )

    assert result["status"] == "blocked"
    assert result["reason"] == "higher_timeframe_data_is_from_the_future"


def test_strategy_lab_finds_volume_confirmed_breakout_but_never_authorizes_execution(monkeypatch):
    primary, higher, now_ms = _aligned_history(breakout=True)

    def fake_analysis(candles, bars_per_day=24.0):
        if bars_per_day == 24.0:
            return {
                "signal": "HOLD", "score": 50, "regime": "RANGE_OR_TRANSITION",
                "rsi14": 55.0, "atr_pct": 1.0, "adx14": 25.0,
                "plus_di14": 30.0, "minus_di14": 10.0, "ema50": 99.0,
            }
        return {
            "signal": "HOLD", "score": 60, "regime": "UPTREND",
            "rsi14": 55.0, "atr_pct": 1.0, "adx14": 25.0,
            "plus_di14": 30.0, "minus_di14": 10.0, "ema50": 99.0,
        }

    monkeypatch.setattr(strategy_lab, "analyze_candles", fake_analysis)
    result = strategy_lab.evaluate_strategy_candidates(
        primary, higher, higher_interval_ms=FOUR_HOURS_MS, now_ms=now_ms
    )

    breakout = next(item for item in result["candidates"] if item["strategy_id"] == "volatility_breakout")
    assert result["status"] == "research_only"
    assert breakout["signal"] == "RESEARCH_CANDIDATE"
    assert breakout["eligible_for_research"] is True
    assert result["relative_volume_20"] == 2.0
    assert result["execution_authorized"] is False
    assert result["paper_auto_entry_eligible"] is False
    assert result["live_trading_enabled"] is False


def test_strategy_lab_reports_all_three_strategy_families_and_non_probability_scores(monkeypatch):
    primary, higher, now_ms = _aligned_history()

    def fake_analysis(candles, bars_per_day=24.0):
        regime = "RANGE_OR_TRANSITION" if bars_per_day == 24.0 else "UPTREND"
        return {
            "signal": "HOLD", "score": 50, "regime": regime,
            "rsi14": 50.0, "atr_pct": 1.0, "adx14": 15.0,
            "plus_di14": 12.0, "minus_di14": 12.0, "ema50": 99.0,
        }

    monkeypatch.setattr(strategy_lab, "analyze_candles", fake_analysis)
    result = strategy_lab.evaluate_strategy_candidates(
        primary, higher, higher_interval_ms=FOUR_HOURS_MS, now_ms=now_ms
    )

    assert [item["strategy_id"] for item in result["candidates"]] == [
        "trend_pullback", "volatility_breakout", "range_mean_reversion"
    ]
    assert all(item["score_is_probability"] is False for item in result["candidates"])
    assert result["ranking_method"].startswith("fixed transparent rule count")
    assert result["execution_authorized"] is False
