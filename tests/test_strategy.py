from app.services.backtest import run_ema_backtest
from app.services.market_data import MarketDataService
from app.services.strategy import analyze_candles, score_solana_token


def make_candles(closes):
    rows = []
    previous = closes[0]
    for i, close in enumerate(closes):
        op = previous
        rows.append([i * 60_000, op, max(op, close) * 1.002, min(op, close) * 0.998, close, 1000 + i * 2])
        previous = close
    return rows


def test_jupiter_token_field_mapping_uses_authority_disabled_flags():
    normalized = MarketDataService._normalize_token({
        "id": "mint-address", "name": "Sample", "symbol": "SMP", "isVerified": True,
        "organicScore": 98.0, "usdPrice": 1.0, "liquidity": 100000,
        "holderCount": 2000,
        "audit": {"mintAuthorityDisabled": True, "freezeAuthorityDisabled": True,
                   "topHoldersPercentage": 10.0}
    })
    screen = score_solana_token(normalized)
    assert normalized["mint_authority_disabled"] is True
    assert normalized["freeze_authority_disabled"] is True
    assert screen["eligible_for_paper"] is True


def test_jupiter_token_unknown_authority_is_rejected():
    token = {"liquidity_usd": 100000, "holders": 5000, "organic_score": 95,
             "verified": True, "price_usd": 1, "mint_authority_disabled": None,
             "freeze_authority_disabled": None}
    screen = score_solana_token(token)
    assert screen["eligible_for_paper"] is False
    assert len(screen["flags"]) >= 2


def test_multi_crypto_analysis_requires_ema_warmup_then_blocks_extended_rsi():
    short = analyze_candles(make_candles([100 + i * 0.5 for i in range(70)]))
    assert short["signal"] == "HOLD"
    assert short["regime"] == "INSUFFICIENT_DATA"
    candles = make_candles([100 + i * 0.5 for i in range(180)])
    result = analyze_candles(candles)
    assert result["signal"] == "HOLD"
    assert result["rsi14"] == 100.0
    assert result["regime"] in {"UPTREND", "HIGH_VOLATILITY", "RANGE_OR_TRANSITION"}
    assert "atr_pct" in result and "volume_ratio_20" in result and "adx14" in result
    assert any("extended" in reason.lower() for reason in result["reasons"])


def test_analysis_rejects_insufficient_or_malformed_ohlcv():
    result = analyze_candles([[i, 1, 1, 1, 1, 100] for i in range(10)])
    assert result["signal"] == "HOLD"
    assert result["valid_candles"] == 10
    malformed = analyze_candles([[i, 1, 0.5, 1.5, 1, 100] for i in range(70)])
    assert malformed["valid_candles"] == 0


def test_backtest_returns_cost_assumptions_and_execution_model():
    closes = [100 + i * 0.3 for i in range(80)] + [124 - (i - 80) * 0.3 for i in range(40)]
    result = run_ema_backtest(make_candles(closes), fee_bps=10, slippage_bps=10)
    assert "max_drawdown_pct" in result
    assert result["cost_assumptions"]["fee_bps_per_side"] == 10
    assert result["ending_equity_usd"] > 0
    assert "next candle open" in result["execution_model"]
    assert "profit_factor" in result


def test_banned_jupiter_token_is_rejected():
    token = {"liquidity_usd": 100000, "holders": 5000, "organic_score": 95,
             "verified": True, "banned": True, "price_usd": 1,
             "mint_authority_disabled": True, "freeze_authority_disabled": True,
             "top_holders_percentage": 10}
    screen = score_solana_token(token)
    assert screen["eligible_for_paper"] is False
    assert any("banned" in flag.lower() for flag in screen["flags"])


def test_solana_holder_concentration_35_percent_is_rejected():
    token = {"liquidity_usd": 100000, "holders": 5000, "organic_score": 95,
             "verified": True, "price_usd": 1, "mint_authority_disabled": True,
             "freeze_authority_disabled": True, "top_holders_percentage": 35}
    screen = score_solana_token(token)
    assert screen["eligible_for_paper"] is False
    assert any("concentration" in flag.lower() for flag in screen["flags"])


def test_walk_forward_is_chronological_and_reports_each_fold():
    closes = [100 + i * 0.15 for i in range(150)] + [122.5 - (i - 150) * 0.08 for i in range(90)]
    result = __import__("app.services.backtest", fromlist=["run_walk_forward"]).run_walk_forward(
        make_candles(closes), folds=3, fee_bps=10, slippage_bps=10
    )
    assert result["total_folds"] == 3
    assert len(result["folds"]) == 3
    assert [x["cost_multiplier"] for x in result["cost_stress"]] == [1.0, 1.5, 2.0]
    assert result["folds"][0]["test_end_timestamp"] < result["folds"][1]["test_start_timestamp"]
    assert "not proof" in result["warning"]


def test_candle_gap_counter_reports_missing_and_off_grid_intervals():
    from app.services.strategy import candle_gap_count

    rows = [[0, 1, 1.1, 0.9, 1, 10], [3_600_000, 1, 1.1, 0.9, 1, 10],
            [10_800_000, 1, 1.1, 0.9, 1, 10]]
    assert candle_gap_count(rows, 3_600_000) == 1
    off_grid = [[0, 1, 1.1, 0.9, 1, 10], [3_700_000, 1, 1.1, 0.9, 1, 10]]
    assert candle_gap_count(off_grid, 3_600_000) == 1


def test_candle_integrity_reports_duplicates_invalid_and_absolute_off_grid_timestamps():
    from app.services.strategy import candle_integrity_report

    interval = 3_600_000
    rows = [
        [0, 1, 1.1, 0.9, 1, 10],
        [0, 1, 1.1, 0.9, 1, 10],
        [interval + 10_000, 1, 1.1, 0.9, 1, 10],
        [2 * interval, 1, 0.5, 1.5, 1, 10],
    ]
    result = candle_integrity_report(rows, interval)
    assert result["duplicate_timestamps"] == 1
    assert result["off_grid_timestamps"] == 1
    assert result["invalid_rows"] == 1
    assert result["is_clean"] is False


def test_candle_integrity_accepts_clean_hourly_history():
    from app.services.strategy import candle_integrity_report

    rows = [[i * 3_600_000, 10, 11, 9, 10, 100] for i in range(160)]
    result = candle_integrity_report(rows, 3_600_000)
    assert result["is_clean"] is True
    assert result["valid_unique_candles"] == 160


def test_coinbase_market_data_marks_duplicate_candle_history_as_data_gap(monkeypatch):
    import asyncio
    import time
    import app.services.market_data as market_data_module
    from app.services.market_data import MarketDataService
    from app.settings import Settings

    now_ms = int(time.time() * 1000)
    hour = 3_600_000
    six_hours = 6 * hour
    primary_start = (now_ms // hour) * hour - 170 * hour
    higher_start = (now_ms // six_hours) * six_hours - 170 * six_hours
    primary = [[primary_start + i * hour, 100 + i * .02, 101 + i * .02,
                99 + i * .02, 100.5 + i * .02, 1000] for i in range(170)]
    higher = [[higher_start + i * six_hours, 100 + i * .05, 102 + i * .05,
               98 + i * .05, 101 + i * .05, 4000] for i in range(170)]
    primary[100] = primary[99].copy()

    class FakeCoinbaseAdapter:
        async def __aenter__(self): return self
        async def __aexit__(self, exc_type, exc, traceback): return None
        async def fetch_candles(self, _symbol, granularity_seconds):
            return primary if granularity_seconds == 3600 else higher

    monkeypatch.setattr(market_data_module, "CoinbasePublicAdapter", FakeCoinbaseAdapter)
    service = MarketDataService(Settings())
    result = asyncio.run(service.cex_strategy_data("BTC/USD", limit=300))
    assert result["status"] == "live"
    assert result["data_quality"]["primary_integrity"]["duplicate_timestamps"] == 1
    assert result["data_quality"]["contiguous_closed_candles"] is False
    assert result["analysis"]["signal"] == "HOLD"
    assert result["analysis"]["regime"] == "DATA_GAP"


def test_market_momentum_reports_macd_roc_and_acceleration_states():
    rising = make_candles([100 + 0.03 * i + 0.0005 * i * i for i in range(220)])
    rising_result = analyze_candles(rising)
    assert rising_result["momentum_state"] == "BULLISH_ACCELERATING"
    assert rising_result["momentum_score"] > 50
    assert rising_result["roc_5_pct"] > 0
    assert rising_result["roc_10_pct"] > 0
    assert rising_result["roc_20_pct"] > 0
    assert rising_result["macd_histogram"] > 0
    assert "MACD is above its signal line" in rising_result["momentum_reasons"]

    falling = make_candles([200 - 0.03 * i - 0.0005 * i * i for i in range(220)])
    falling_result = analyze_candles(falling)
    assert falling_result["momentum_state"] == "BEARISH_ACCELERATING"
    assert falling_result["momentum_score"] < 50
    assert falling_result["roc_10_pct"] < 0
    assert falling_result["macd_histogram"] < 0

    flat = make_candles([100.0 for _ in range(220)])
    flat_result = analyze_candles(flat)
    assert flat_result["momentum_state"] == "MIXED_OR_NEUTRAL"
    assert flat_result["momentum_score"] == 50
