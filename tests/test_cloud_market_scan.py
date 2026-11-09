from scripts.cloud_market_scan import compare_market_sources, market_is_fresh, ticker_age_ms, timeframes_are_aligned


def test_market_is_fresh_requires_live_and_recent_timestamp():
    now = 1_800_000_000_000
    assert market_is_fresh({"status": "live", "timestamp": now - 30_000}, now)
    assert not market_is_fresh({"status": "live", "timestamp": now - 130_000}, now)
    assert not market_is_fresh({"status": "error", "timestamp": now}, now)


def test_market_is_fresh_rejects_missing_invalid_and_far_future_timestamp():
    now = 1_800_000_000_000
    assert not market_is_fresh({"status": "live"}, now)
    assert not market_is_fresh({"status": "live", "timestamp": "bad"}, now)
    assert market_is_fresh({"status": "live", "timestamp": now + 500}, now)
    assert not market_is_fresh({"status": "live", "timestamp": now + 5_001}, now)
    assert not market_is_fresh({"status": "live", "timestamp": now + 10_000}, now)


def test_ticker_age_ms_returns_none_for_non_finite_values():
    assert ticker_age_ms(float("nan"), 1_800_000_000_000) is None
    assert ticker_age_ms(float("inf"), 1_800_000_000_000) is None



def test_market_sources_must_match_provider_and_quote_currency():
    same_source = compare_market_sources(
        {"market_data_provider": "binance", "quote_currency": "USDT"},
        {"provider": "binance", "quote_currency": "USDT"},
    )
    assert same_source["matched"] is True
    assert same_source["issues"] == []

    mismatched_provider = compare_market_sources(
        {"market_data_provider": "binance", "quote_currency": "USDT"},
        {"provider": "coinbase_public_fallback", "quote_currency": "USD"},
    )
    assert mismatched_provider["matched"] is False
    assert "provider_mismatch:ticker=binance,strategy=coinbase_public_fallback" in mismatched_provider["issues"]
    assert "quote_currency_mismatch:ticker=USDT,strategy=USD" in mismatched_provider["issues"]

    unknown_source = compare_market_sources(
        {"quote_currency": "USDT"},
        {"quote_currency": "USDT"},
    )
    assert unknown_source["matched"] is False
    assert "ticker_provider_missing" in unknown_source["issues"]
    assert "strategy_provider_missing" in unknown_source["issues"]


def test_coinbase_fallback_is_consistent_when_both_ticker_and_candles_use_usd():
    result = compare_market_sources(
        {"market_data_provider": "coinbase_public_fallback", "quote_currency": "USD"},
        {"provider": "coinbase_public_fallback", "quote_currency": "USD"},
    )
    assert result["matched"] is True



def test_timeframes_require_confirmed_matching_directional_regimes():
    aligned_up = {
        "timeframe_confluence": "ALIGNED",
    }
    primary_up = {"regime": "UPTREND"}
    higher_up = {"regime": "UPTREND"}
    assert timeframes_are_aligned(aligned_up, primary_up, higher_up) is True

    assert timeframes_are_aligned(
        aligned_up,
        {"regime": "UPTREND"},
        {"regime": "DOWNTREND"},
    ) is False

    assert timeframes_are_aligned(
        {"timeframe_confluence": "MIXED_OR_UNCONFIRMED"},
        primary_up,
        higher_up,
    ) is False

    assert timeframes_are_aligned(
        aligned_up,
        {"regime": "RANGE_OR_TRANSITION"},
        {"regime": "RANGE_OR_TRANSITION"},
    ) is False

    assert timeframes_are_aligned(
        aligned_up,
        {"regime": "DATA_GAP"},
        {"regime": "DATA_GAP"},
    ) is False
