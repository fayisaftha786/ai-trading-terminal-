from scripts.cloud_market_scan import market_is_fresh, ticker_age_ms


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
