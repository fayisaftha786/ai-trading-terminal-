from __future__ import annotations

from math import isfinite, sqrt
from statistics import mean, pstdev
from typing import Any


def ema(values: list[float], period: int) -> list[float]:
    """EMA seeded with the first-period SMA to reduce startup bias."""
    if not values or period < 1:
        return []
    if len(values) < period:
        return [float(values[0])] * len(values)
    alpha = 2.0 / (period + 1)
    seed = sum(float(v) for v in values[:period]) / period
    result = [float(values[0])] * (period - 1) + [seed]
    for value in values[period:]:
        result.append(alpha * float(value) + (1 - alpha) * result[-1])
    return result


def rsi(values: list[float], period: int = 14) -> float | None:
    """Wilder RSI, using recursive smoothing rather than a simple moving average."""
    if period < 1 or len(values) <= period:
        return None
    changes = [float(values[i]) - float(values[i - 1]) for i in range(1, len(values))]
    avg_gain = sum(max(change, 0.0) for change in changes[:period]) / period
    avg_loss = sum(max(-change, 0.0) for change in changes[:period]) / period
    for change in changes[period:]:
        avg_gain = (avg_gain * (period - 1) + max(change, 0.0)) / period
        avg_loss = (avg_loss * (period - 1) + max(-change, 0.0)) / period
    if avg_loss <= 0:
        return 100.0 if avg_gain > 0 else 50.0
    relative_strength = avg_gain / avg_loss
    return 100.0 - (100.0 / (1.0 + relative_strength))


def _valid(value: Any) -> bool:
    try:
        return isfinite(float(value)) and float(value) > 0
    except (TypeError, ValueError, OverflowError):
        return False


def _clean_candles(candles: list[list[float]]) -> list[list[float]]:
    clean: list[list[float]] = []
    for row in candles:
        if len(row) < 6:
            continue
        try:
            ts, op, high, low, close, volume = map(float, row[:6])
        except (TypeError, ValueError, OverflowError):
            continue
        if not all(isfinite(x) for x in (ts, op, high, low, close, volume)):
            continue
        if min(op, high, low, close) <= 0 or volume < 0 or high < max(op, close, low) or low > min(op, close, high):
            continue
        clean.append([ts, op, high, low, close, volume])
    clean.sort(key=lambda x: x[0])
    # Keep the last row for a duplicated timestamp. Out-of-order input is normalized.
    deduped: dict[float, list[float]] = {row[0]: row for row in clean}
    return [deduped[key] for key in sorted(deduped)]


def _wilder_atr_adx(rows: list[list[float]], period: int = 14) -> tuple[float | None, float | None, float | None, float | None]:
    """Return Wilder ATR, ADX, +DI and -DI from closed OHLCV rows."""
    if len(rows) < 2 * period + 1:
        return None, None, None, None
    true_ranges: list[float] = []
    plus_moves: list[float] = []
    minus_moves: list[float] = []
    for i in range(1, len(rows)):
        previous_close = rows[i - 1][4]
        high_move = rows[i][2] - rows[i - 1][2]
        low_move = rows[i - 1][3] - rows[i][3]
        true_ranges.append(max(rows[i][2] - rows[i][3], abs(rows[i][2] - previous_close), abs(rows[i][3] - previous_close)))
        plus_moves.append(high_move if high_move > low_move and high_move > 0 else 0.0)
        minus_moves.append(low_move if low_move > high_move and low_move > 0 else 0.0)

    atr_smooth = sum(true_ranges[:period]) / period
    plus_smooth = sum(plus_moves[:period])
    minus_smooth = sum(minus_moves[:period])
    dx_values: list[float] = []
    latest_plus_di = latest_minus_di = 0.0
    latest_atr = atr_smooth
    for i in range(period - 1, len(true_ranges)):
        if i >= period:
            atr_smooth = (atr_smooth * (period - 1) + true_ranges[i]) / period
            plus_smooth = plus_smooth - (plus_smooth / period) + plus_moves[i]
            minus_smooth = minus_smooth - (minus_smooth / period) + minus_moves[i]
        latest_atr = atr_smooth
        if atr_smooth <= 0:
            plus_di = minus_di = 0.0
        else:
            plus_di = 100.0 * plus_smooth / (period * atr_smooth)
            minus_di = 100.0 * minus_smooth / (period * atr_smooth)
        latest_plus_di, latest_minus_di = plus_di, minus_di
        denominator = plus_di + minus_di
        dx_values.append(100.0 * abs(plus_di - minus_di) / denominator if denominator > 0 else 0.0)

    if len(dx_values) < period:
        return latest_atr, None, latest_plus_di, latest_minus_di
    adx_value = sum(dx_values[:period]) / period
    for value in dx_values[period:]:
        adx_value = (adx_value * (period - 1) + value) / period
    return latest_atr, adx_value, latest_plus_di, latest_minus_di


def candle_gap_count(candles: list[list[float]], expected_interval_ms: int) -> int:
    """Count missing/off-grid intervals after normalizing OHLCV rows."""
    if expected_interval_ms <= 0:
        raise ValueError("Expected candle interval must be positive")
    rows = _clean_candles(candles)
    gaps = 0
    for previous, current in zip(rows, rows[1:]):
        delta = current[0] - previous[0]
        multiples = delta / float(expected_interval_ms)
        nearest = round(multiples)
        if nearest < 1 or abs(multiples - nearest) > 0.02:
            gaps += 1
        elif nearest > 1:
            gaps += nearest - 1
    return gaps


def candle_integrity_report(candles: list[list[float]], expected_interval_ms: int) -> dict[str, Any]:
    """Audit raw OHLCV before normalization so duplicates and malformed rows are visible."""
    if expected_interval_ms <= 0:
        raise ValueError("Expected candle interval must be positive")
    valid_rows: list[list[float]] = []
    invalid_rows = 0
    timestamp_counts: dict[int, int] = {}
    off_grid_timestamps = 0
    # CCXT OHLCV open times for minute/hour/day intervals are UTC epoch aligned.
    # Weekly/monthly calendar bars have exchange-specific anchors, so only spacing is checked there.
    check_epoch_alignment = expected_interval_ms <= 86_400_000
    alignment_tolerance_ms = 2.0
    for row in candles:
        if not isinstance(row, (list, tuple)) or len(row) < 6:
            invalid_rows += 1
            continue
        try:
            ts, op, high, low, close, volume = map(float, row[:6])
        except (TypeError, ValueError, OverflowError):
            invalid_rows += 1
            continue
        if (not all(isfinite(x) for x in (ts, op, high, low, close, volume))
                or min(op, high, low, close) <= 0 or volume < 0
                or high < max(op, close, low) or low > min(op, close, high)):
            invalid_rows += 1
            continue
        valid_rows.append([ts, op, high, low, close, volume])
        timestamp_key = int(round(ts))
        timestamp_counts[timestamp_key] = timestamp_counts.get(timestamp_key, 0) + 1
        if check_epoch_alignment:
            remainder = ts % float(expected_interval_ms)
            distance = min(remainder, float(expected_interval_ms) - remainder)
            if distance > alignment_tolerance_ms:
                off_grid_timestamps += 1

    duplicate_timestamps = sum(count - 1 for count in timestamp_counts.values() if count > 1)
    rows = _clean_candles(valid_rows)
    missing_intervals = 0
    off_interval_pairs = 0
    for previous, current in zip(rows, rows[1:]):
        multiples = (current[0] - previous[0]) / float(expected_interval_ms)
        nearest = round(multiples)
        if nearest < 1 or abs(multiples - nearest) > 0.02:
            off_interval_pairs += 1
        elif nearest > 1:
            missing_intervals += nearest - 1

    is_clean = not any((invalid_rows, duplicate_timestamps, off_grid_timestamps,
                        off_interval_pairs, missing_intervals))
    return {
        "received_candles": len(candles),
        "valid_unique_candles": len(rows),
        "invalid_rows": invalid_rows,
        "duplicate_timestamps": duplicate_timestamps,
        "off_grid_timestamps": off_grid_timestamps,
        "off_interval_pairs": off_interval_pairs,
        "missing_intervals": missing_intervals,
        "is_clean": is_clean,
    }


def analyze_candles(candles: list[list[float]], bars_per_day: float = 24.0) -> dict[str, Any]:
    """Explainable trend/momentum analysis. It identifies setups; it is not a forecast."""
    rows = _clean_candles(candles)
    minimum_history = 150
    if len(rows) < minimum_history:
        return {"signal": "HOLD", "score": 0, "regime": "INSUFFICIENT_DATA",
                "reason": f"At least {minimum_history} valid, unique closed OHLCV candles are required for EMA warm-up",
                "valid_candles": len(rows), "required_candles": minimum_history}

    closes = [row[4] for row in rows]
    highs = [row[2] for row in rows]
    lows = [row[3] for row in rows]
    volumes = [row[5] for row in rows]
    fast, slow = ema(closes, 20), ema(closes, 50)
    current_rsi = rsi(closes, 14)
    atr, adx, plus_di, minus_di = _wilder_atr_adx(rows, 14)
    if atr is None or adx is None or current_rsi is None:
        return {"signal": "HOLD", "score": 0, "regime": "INSUFFICIENT_INDICATOR_HISTORY",
                "reason": "Wilder RSI, ATR and ADX need more valid closed candles", "valid_candles": len(rows)}

    returns = [(closes[i] / closes[i - 1]) - 1 for i in range(max(1, len(closes) - 20), len(closes))]
    safe_bars_per_day = max(1.0, min(float(bars_per_day), 1440.0))
    realized_vol_pct = pstdev(returns) * sqrt(safe_bars_per_day) * 100 if len(returns) > 1 else 0.0
    atr_pct = atr / closes[-1] * 100 if closes[-1] else 0.0
    vol_window = volumes[-20:]
    prior_vol = volumes[-40:-20]
    volume_ratio = (mean(vol_window) / mean(prior_vol)) if prior_vol and mean(prior_vol) > 0 else None
    range_high = max(highs[-20:-1])
    range_low = min(lows[-20:-1])
    breakout = "ABOVE_20_BAR_HIGH" if closes[-1] > range_high else "BELOW_20_BAR_LOW" if closes[-1] < range_low else "INSIDE_RANGE"
    ema20_slope_pct = ((fast[-1] / fast[-6]) - 1) * 100 if fast[-6] > 0 else 0.0

    trend_up = fast[-1] > slow[-1] and closes[-1] > slow[-1] and ema20_slope_pct > 0
    trend_down = fast[-1] < slow[-1] and closes[-1] < slow[-1] and ema20_slope_pct < 0
    directional_up = plus_di > minus_di
    if atr_pct >= 8 or realized_vol_pct >= 12:
        regime = "HIGH_VOLATILITY"
    elif trend_up and adx >= 18 and directional_up:
        regime = "UPTREND"
    elif trend_down and adx >= 18 and not directional_up:
        regime = "DOWNTREND"
    else:
        regime = "RANGE_OR_TRANSITION"

    score = 50
    reasons: list[str] = []
    if trend_up:
        score += 20; reasons.append("EMA20 and price are above EMA50 with positive EMA20 slope")
    elif trend_down:
        score -= 20; reasons.append("EMA20 and price are below EMA50 with negative EMA20 slope")
    else:
        reasons.append("Trend alignment or EMA20 slope is mixed")
    if current_rsi is not None and 48 <= current_rsi <= 66:
        score += 10; reasons.append("Wilder RSI supports momentum without being extended")
    elif current_rsi is not None and current_rsi >= 72:
        score -= 15; reasons.append("RSI is extended; chase risk is elevated")
    elif current_rsi is not None and current_rsi <= 30:
        score -= 10; reasons.append("Oversold condition is not treated as an automatic buy")
    if volume_ratio is not None and volume_ratio >= 1.25:
        score += 10; reasons.append("Closed-bar volume exceeds its preceding 20-bar baseline")
    elif volume_ratio is not None and volume_ratio < 0.65:
        score -= 8; reasons.append("Recent volume is weak")
    if breakout == "ABOVE_20_BAR_HIGH":
        score += 10; reasons.append("Close broke above the prior 20-bar high")
    if adx >= 22 and directional_up:
        score += 10; reasons.append("ADX and positive directional index confirm trend strength")
    elif adx < 15:
        score -= 10; reasons.append("ADX indicates weak directional trend")
    if atr_pct >= 8 or realized_vol_pct >= 12:
        score -= 20; reasons.append("Volatility is too high for the conservative baseline")
    elif atr_pct <= 0.15:
        score -= 5; reasons.append("Very low range may not cover execution costs")
    score = max(0, min(100, score))
    signal = "BUY_CANDIDATE" if (
        score >= 75 and regime == "UPTREND" and atr_pct < 8 and adx >= 18
        and directional_up and current_rsi < 68
    ) else "HOLD"
    return {
        "signal": signal, "score": score, "regime": regime,
        "rsi14": round(current_rsi, 2), "ema20": round(fast[-1], 10), "ema50": round(slow[-1], 10),
        "ema20_slope_pct": round(ema20_slope_pct, 5), "atr14": round(atr, 10),
        "atr_pct": round(atr_pct, 4), "adx14": round(adx, 3),
        "plus_di14": round(plus_di, 3), "minus_di14": round(minus_di, 3),
        "realized_volatility_pct_approx": round(realized_vol_pct, 4),
        "volume_ratio_20": round(volume_ratio, 4) if volume_ratio is not None else None,
        "breakout_20": breakout, "valid_candles": len(rows), "reasons": reasons,
        "method": "SMA-seeded EMA20/50 + Wilder RSI14/ATR14/ADX14 + directional movement + closed-bar volume ratio + 20-bar breakout + volatility guard",
        "warning": "Research signal only. It does not predict or guarantee returns; automatic paper entries additionally require higher-timeframe alignment, fresh executable quotes, spread, depth, liquidity and portfolio risk approval."
    }


def score_solana_token(token: dict[str, Any]) -> dict[str, Any]:
    """Conservative heuristic. Missing security data is not treated as proof of safety."""
    hard_flags = []
    if token.get("is_sus"):
        hard_flags.append("Jupiter marks token as suspicious")
    if token.get("banned"):
        hard_flags.append("Jupiter marks token as banned")
    if token.get("mint_authority_disabled") is not True:
        hard_flags.append("Mint authority is not confirmed disabled")
    if token.get("freeze_authority_disabled") is not True:
        hard_flags.append("Freeze authority is not confirmed disabled")
    top_holders_raw = token.get("top_holders_percentage")
    try:
        top_holders = float(top_holders_raw) if top_holders_raw is not None else None
    except (TypeError, ValueError):
        top_holders = None
    if top_holders is None:
        hard_flags.append("Top-holder concentration data is missing or invalid")
    elif not isfinite(top_holders) or not 0 <= top_holders <= 100:
        hard_flags.append("Top-holder concentration data is invalid")
    elif top_holders >= 35:
        hard_flags.append("Top-holder concentration is 35% or higher")
    liquidity_value = token.get("liquidity_usd")
    holders_value = token.get("holders")
    organic = token.get("organic_score")
    try:
        liquidity = float(liquidity_value) if liquidity_value is not None else 0.0
    except (TypeError, ValueError):
        liquidity = 0.0
    try:
        holders = float(holders_value) if holders_value is not None else 0.0
    except (TypeError, ValueError):
        holders = 0.0
    if not isfinite(liquidity) or liquidity < 0:
        hard_flags.append("Liquidity data is invalid")
        liquidity = 0.0
    if not isfinite(holders) or holders < 0:
        hard_flags.append("Holder-count data is invalid")
        holders = 0.0
    if organic is not None:
        try:
            organic = float(organic)
            if not isfinite(organic):
                organic = None
        except (TypeError, ValueError):
            organic = None
    score = 0
    if liquidity >= 100_000: score += 25
    elif liquidity >= 25_000: score += 18
    elif liquidity >= 10_000: score += 10
    elif liquidity >= 2_500: score += 3
    if holders >= 2_000: score += 15
    elif holders >= 500: score += 10
    elif holders >= 100: score += 5
    if token.get("verified"): score += 10
    if token.get("mint_authority_disabled") is True and token.get("freeze_authority_disabled") is True: score += 15
    if top_holders is not None and top_holders < 15: score += 10
    if organic is not None: score += max(0, min(15, round(float(organic) / 7)))
    price_value = token.get("price_usd")
    try:
        price_value = float(price_value) if price_value is not None else 0.0
    except (TypeError, ValueError):
        price_value = 0.0
    if isfinite(price_value) and price_value > 0: score += 10
    if liquidity < 2_500: hard_flags.append("Liquidity below minimum screening threshold")
    score = max(0, min(100, score))
    eligible = not hard_flags and score >= 65
    return {"score": score, "eligible_for_paper": eligible, "flags": hard_flags,
            "disclaimer": "Heuristic screening only; not a security audit or buy recommendation"}
