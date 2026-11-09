from __future__ import annotations

import time
from math import isfinite
from statistics import mean, pstdev
from typing import Any

from app.services.strategy import analyze_candles, candle_integrity_report, ema


PRIMARY_INTERVAL_MS = 60 * 60 * 1000
MIN_HISTORY_BARS = 150


def _number(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return result if isfinite(result) else None


def _closed_rows(candles: list[Any], interval_ms: int, now_ms: float) -> list[Any]:
    closed: list[Any] = []
    for row in candles:
        if not isinstance(row, (list, tuple)) or len(row) < 6:
            # Keep malformed rows visible to the integrity audit.
            closed.append(row)
            continue
        stamp = _number(row[0])
        if stamp is None:
            closed.append(row)
        elif stamp + interval_ms <= now_ms:
            closed.append(row)
    return closed


def _blocked(
    reason: str,
    primary_quality: dict[str, Any] | None = None,
    higher_quality: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "status": "blocked",
        "reason": reason,
        "primary_data_quality": primary_quality,
        "higher_data_quality": higher_quality,
        "candidates": [],
        "best_research_candidate": None,
        "execution_authorized": False,
        "paper_auto_entry_eligible": False,
        "live_trading_enabled": False,
        "warning": "Research-only strategy comparison. No paper or live orders are authorized.",
    }


def _candidate(
    strategy_id: str,
    label: str,
    eligible: bool,
    score: int,
    reasons: list[str],
) -> dict[str, Any]:
    return {
        "strategy_id": strategy_id,
        "label": label,
        "signal": "RESEARCH_CANDIDATE" if eligible else "HOLD",
        "eligible_for_research": bool(eligible),
        "heuristic_score": max(0, min(100, int(score))),
        "score_is_probability": False,
        "reasons": reasons,
        "execution_authorized": False,
    }


def evaluate_strategy_candidates(
    primary_candles: list[list[float]],
    higher_candles: list[list[float]],
    *,
    higher_interval_ms: int,
    now_ms: float | None = None,
) -> dict[str, Any]:
    """Compare three spot-long hypotheses on clean, fully closed bars.

    This module is deliberately disconnected from AutoPaperEngine and all order
    executors. A candidate must pass independent backtesting and forward PAPER
    validation before anyone considers enabling it.
    """
    if not isinstance(primary_candles, list) or not isinstance(higher_candles, list):
        return _blocked("candle_history_not_list")
    if not isinstance(higher_interval_ms, int) or higher_interval_ms <= 0:
        return _blocked("higher_timeframe_interval_invalid")
    evaluation_time = float(now_ms if now_ms is not None else time.time() * 1000)
    if not isfinite(evaluation_time) or evaluation_time <= 0:
        return _blocked("evaluation_timestamp_invalid")

    primary_rows = _closed_rows(primary_candles, PRIMARY_INTERVAL_MS, evaluation_time)
    higher_rows = _closed_rows(higher_candles, higher_interval_ms, evaluation_time)
    primary_quality = candle_integrity_report(primary_rows, PRIMARY_INTERVAL_MS)
    higher_quality = candle_integrity_report(higher_rows, higher_interval_ms)
    if not primary_quality["is_clean"] or not higher_quality["is_clean"]:
        return _blocked("candle_integrity_failed", primary_quality, higher_quality)
    # Provider adapters do not all guarantee identical row order. Audit raw
    # observations first, then normalize both clean histories chronologically.
    primary_rows.sort(key=lambda row: float(row[0]))
    higher_rows.sort(key=lambda row: float(row[0]))
    if (
        primary_quality["valid_unique_candles"] < MIN_HISTORY_BARS
        or higher_quality["valid_unique_candles"] < MIN_HISTORY_BARS
    ):
        return _blocked("insufficient_closed_history", primary_quality, higher_quality)
    primary_closed_at = float(primary_rows[-1][0]) + PRIMARY_INTERVAL_MS
    higher_closed_at = float(higher_rows[-1][0]) + higher_interval_ms
    if higher_closed_at > primary_closed_at:
        return _blocked("higher_timeframe_data_is_from_the_future", primary_quality, higher_quality)

    primary = analyze_candles(primary_rows, bars_per_day=24.0)
    higher = analyze_candles(higher_rows, bars_per_day=86_400_000 / higher_interval_ms)
    required = ("rsi14", "atr_pct", "adx14", "plus_di14", "minus_di14", "ema50")
    for analysis in (primary, higher):
        if not all(_number(analysis.get(key)) is not None for key in required):
            return _blocked("indicator_metrics_invalid", primary_quality, higher_quality)

    closes = [float(row[4]) for row in primary_rows]
    highs = [float(row[2]) for row in primary_rows]
    volumes = [float(row[5]) for row in primary_rows]
    close = closes[-1]
    prior_high = max(highs[-21:-1])
    recent_volume = mean(volumes[-20:])
    previous_volume = mean(volumes[-40:-20])
    volume_ratio = recent_volume / previous_volume if previous_volume > 0 else None

    # Strategy A: trend pullback, with a reclaim of EMA20 after a pullback.
    fast = ema(closes, 20)
    pullback_reclaim = len(fast) >= 3 and closes[-2] <= fast[-2] and close > fast[-1]
    trend_conditions = {
        "higher_timeframe_uptrend": higher.get("regime") == "UPTREND",
        "primary_price_above_ema50": close > float(primary["ema50"]),
        "ema20_reclaimed_after_pullback": pullback_reclaim,
        "directional_strength": (
            float(primary["adx14"]) >= 18
            and float(primary["plus_di14"]) > float(primary["minus_di14"])
        ),
        "rsi_not_overextended": 45 <= float(primary["rsi14"]) <= 68,
        "volatility_not_extreme": 0 < float(primary["atr_pct"]) < 5,
    }
    trend_candidate = _candidate(
        "trend_pullback",
        "Trend pullback and EMA reclaim",
        all(trend_conditions.values()),
        50 + sum(8 for passed in trend_conditions.values() if passed),
        [name for name, passed in trend_conditions.items() if passed]
        or ["trend_pullback_filters_not_aligned"],
    )

    # Strategy B: breakout must clear the previous 20 bars and expand volume.
    breakout_conditions = {
        "higher_timeframe_uptrend": higher.get("regime") == "UPTREND",
        "close_above_prior_20_bar_high": close > prior_high,
        "relative_volume_at_least_1_5x": volume_ratio is not None and volume_ratio >= 1.5,
        "adx_at_least_20": float(primary["adx14"]) >= 20,
        "positive_directional_movement": float(primary["plus_di14"]) > float(primary["minus_di14"]),
        "volatility_not_extreme": 0 < float(primary["atr_pct"]) < 5,
    }
    breakout_candidate = _candidate(
        "volatility_breakout",
        "20-bar breakout with volume expansion",
        all(breakout_conditions.values()),
        50 + sum(8 for passed in breakout_conditions.values() if passed),
        [name for name, passed in breakout_conditions.items() if passed]
        or ["breakout_filters_not_aligned"],
    )

    # Strategy C: only buy a confirmed reclaim into the range; do not catch a
    # falling knife while price remains below the lower Bollinger band.
    current_window = closes[-20:]
    previous_window = closes[-21:-1]
    current_lower = mean(current_window) - 2 * pstdev(current_window)
    previous_lower = mean(previous_window) - 2 * pstdev(previous_window)
    reclaimed_lower_band = closes[-2] <= previous_lower and close > current_lower
    range_conditions = {
        "primary_range_regime": primary.get("regime") == "RANGE_OR_TRANSITION",
        "higher_range_regime": higher.get("regime") == "RANGE_OR_TRANSITION",
        "adx_below_18": float(primary["adx14"]) < 18,
        "rsi_at_or_below_40": float(primary["rsi14"]) <= 40,
        "reclaimed_lower_bollinger_band": reclaimed_lower_band,
        "volatility_not_extreme": 0 < float(primary["atr_pct"]) < 4,
    }
    range_candidate = _candidate(
        "range_mean_reversion",
        "Range mean reversion after lower-band reclaim",
        all(range_conditions.values()),
        50 + sum(8 for passed in range_conditions.values() if passed),
        [name for name, passed in range_conditions.items() if passed]
        or ["range_reversion_filters_not_aligned"],
    )

    candidates = [trend_candidate, breakout_candidate, range_candidate]
    eligible = [item for item in candidates if item["eligible_for_research"]]
    eligible.sort(key=lambda item: item["heuristic_score"], reverse=True)
    return {
        "status": "research_only",
        "primary_regime": primary.get("regime", "UNKNOWN"),
        "higher_regime": higher.get("regime", "UNKNOWN"),
        "primary_score": primary.get("score", 0),
        "higher_score": higher.get("score", 0),
        "relative_volume_20": round(volume_ratio, 4) if volume_ratio is not None else None,
        "candidates": candidates,
        "best_research_candidate": eligible[0]["strategy_id"] if eligible else None,
        "ranking_method": "fixed transparent rule count; not trained, calibrated or a probability",
        "primary_data_quality": primary_quality,
        "higher_data_quality": higher_quality,
        "execution_authorized": False,
        "paper_auto_entry_eligible": False,
        "live_trading_enabled": False,
        "warning": "Research-only strategy comparison. Candidates are not approved for paper auto-entry or live trading.",
    }
