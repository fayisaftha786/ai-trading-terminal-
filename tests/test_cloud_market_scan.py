from scripts.cloud_market_scan import compare_market_sources, market_is_fresh, render_markdown, ticker_age_ms, timeframes_are_aligned


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
        {"market_data_provider": "other_public_provider", "quote_currency": "EUR"},
        {"provider": "other_public_provider", "quote_currency": "EUR"},
    )
    assert same_source["matched"] is True
    assert same_source["issues"] == []

    mismatched_provider = compare_market_sources(
        {"market_data_provider": "other_public_provider", "quote_currency": "EUR"},
        {"provider": "coinbase_public_fallback", "quote_currency": "USD"},
    )
    assert mismatched_provider["matched"] is False
    assert "provider_mismatch:ticker=other_public_provider,strategy=coinbase_public_fallback" in mismatched_provider["issues"]
    assert "quote_currency_mismatch:ticker=USDT,strategy=USD" in mismatched_provider["issues"]

    unknown_source = compare_market_sources(
        {"quote_currency": "EUR"},
        {"quote_currency": "EUR"},
    )
    assert unknown_source["matched"] is False
    assert "ticker_provider_missing" in unknown_source["issues"]
    assert "strategy_provider_missing" in unknown_source["issues"]


def test_coinbase_fallback_is_consistent_only_when_configured_pair_uses_usd():
    exact_usd = compare_market_sources(
        {"symbol": "BTC/USD", "market_data_provider": "coinbase_public_fallback", "quote_currency": "USD"},
        {"provider": "coinbase_public_fallback", "quote_currency": "USD"},
    )
    assert exact_usd["matched"] is True
    assert exact_usd["quote_basis_verified"] is True

    mapped_usdt = compare_market_sources(
        {"symbol": "BTC/USD", "market_data_provider": "coinbase_public_fallback", "quote_currency": "USD"},
        {"provider": "coinbase_public_fallback", "quote_currency": "USD"},
    )
    assert mapped_usdt["matched"] is True
    assert mapped_usdt["quote_basis_verified"] is True
    assert "configured_pair_quote_mismatch:configured=USD,actual=USD" in mapped_usdt["issues"]



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



def test_scan_report_discloses_configured_exchange_and_actual_fallback_provider():
    report = {
        "generated_at": "2026-11-09T05:20:00+00:00",
        "configured_exchange": "coinbase",
        "exchange": "coinbase_public_fallback",
        "mode": "READ_ONLY_MARKET_SCAN",
        "live_symbol_count": 1,
        "analysis_ready_count": 1,
        "research_candidate_counts": {
            "trend_pullback": 0,
            "volatility_breakout": 0,
            "range_mean_reversion": 0,
        },
        "results": [{
            "symbol": "BTC/EUR",
            "ticker_fresh": True,
            "last": 100.0,
            "signal": "HOLD",
            "score": 40,
            "regime_1h": "DOWNTREND",
            "confirmation_timeframe": "6h",
            "regime_confirmation": "DOWNTREND",
            "providers_match": True,
            "timeframes_aligned": True,
            "spread_bps": 1.0,
            "ticker_provider": "coinbase_public_fallback",
            "strategy_provider": "coinbase_public_fallback",
            "configured_quote_currency": "EUR",
            "ticker_quote_currency": "USD",
            "strategy_quote_currency": "USD",
            "quote_basis_verified": False,
            "signal_block_reasons": ["configured_pair_quote_mismatch:configured=EUR,actual=USD"],
        }],
    }

    rendered = render_markdown(report)
    assert "Configured exchange: binance" in rendered
    assert "Actual market-data adapter: coinbase_public_fallback" in rendered
    assert "ticker=coinbase_public_fallback/USD" in rendered
    assert "candles=coinbase_public_fallback/USD" in rendered
    assert "Quote basis" in rendered
    assert "UNVERIFIED" in rendered
    assert "configured_pair=BTC/EUR; configured_quote=USDT" in rendered
