import time

from app.services.automation import AutoPaperEngine
from app.services.paper import PaperBroker
from app.services.risk import RiskRejected, size_position
from app.storage import DEFAULT_RISK, Storage


def _candidate(symbol="BTC/USDT", *, timestamp=None, spread=0.001):
    if timestamp is None:
        timestamp = time.time() * 1000
    bid = 100.0
    ask = bid + spread
    return {
        "ticker": {
            "symbol": symbol,
            "status": "live",
            "last": bid,
            "bid": bid,
            "ask": ask,
            "quote_volume": 5_000_000,
            "timestamp": timestamp,
            "bid_depth_quote": 250_000,
            "ask_depth_quote": 250_000,
            "orderbook_retrieved_at_ms": time.time() * 1000,
            "orderbook_timestamp_ms": time.time() * 1000,
            "orderbook_timestamp_source": "exchange",
        },
        "analysis": {
            "signal": "BUY_CANDIDATE",
            "score": 82,
            "regime": "UPTREND",
            "atr_pct": 1.2,
            "rsi14": 56.0,
            "adx14": 25.0,
            "plus_di14": 30.0,
            "minus_di14": 20.0,
        },
        "higher_timeframe": {"regime": "UPTREND"},
        "timeframe_confluence": "ALIGNED",
        "last_closed_candle_timestamp_ms": time.time() * 1000 - 3_605_000,
        "higher_timeframe_last_closed_candle_timestamp_ms": time.time() * 1000 - 4 * 3_600_000 - 5_000,
    }


def _engine():
    db = Storage(":memory:")
    db.initialize(100)
    broker = PaperBroker(db)
    return db, broker, AutoPaperEngine(db, broker)


def test_auto_paper_opens_only_after_fresh_aligned_qualified_signal():
    db, broker, engine = _engine()
    result = engine.run([_candidate()], {"BTC/USDT": 100.0}, enabled=True)
    assert result["mode"] == "paper_only"
    assert len(result["paper_entries"]) == 1
    trade = result["paper_entries"][0]
    assert trade["status"] == "OPEN"
    assert trade["metadata"]["automation"] is True
    assert trade["side"] == "BUY"
    assert db.has_open_trade("multi_crypto", "BTC/USDT") is True


def test_auto_paper_rejects_stale_market_data():
    _, _, engine = _engine()
    stale = time.time() * 1000 - 300_000
    result = engine.run([_candidate(timestamp=stale)], {"BTC/USDT": 100.0}, enabled=True)
    assert result["paper_entries"] == []
    assert any(item["reason"] == "stale_or_future_ticker" for item in result["rejected"])


def test_auto_paper_rejects_missing_orderbook_depth():
    _, _, engine = _engine()
    candidate = _candidate()
    candidate["ticker"]["ask_depth_quote"] = None
    result = engine.run([candidate], {"BTC/USDT": 100.0}, enabled=True)
    assert result["paper_entries"] == []
    assert any(item["reason"] == "orderbook_depth_unavailable" for item in result["rejected"])


def test_auto_paper_rejects_non_usd_quote_market():
    _, _, engine = _engine()
    candidate = _candidate("BTC/BTC")
    result = engine.run([candidate], {"BTC/BTC": 100.0}, enabled=True)
    assert result["paper_entries"] == []
    assert any(item["reason"] == "unsupported_non_usd_quote_asset" for item in result["rejected"])


def test_auto_paper_rejects_wide_spread():
    _, _, engine = _engine()
    result = engine.run([_candidate(spread=1.0)], {"BTC/USDT": 100.0}, enabled=True)
    assert result["paper_entries"] == []
    assert any(item["reason"] == "spread_too_wide" for item in result["rejected"])


def test_auto_paper_does_not_duplicate_open_symbol():
    _, _, engine = _engine()
    candidate = _candidate()
    first = engine.run([candidate], {"BTC/USDT": 100.0}, enabled=True)
    assert len(first["paper_entries"]) == 1
    second = engine.run([candidate], {"BTC/USDT": 100.0}, enabled=True)
    assert second["paper_entries"] == []
    assert any(item["reason"] == "already_open_or_invalid_symbol" for item in second["rejected"])


def test_auto_paper_stays_disabled_without_opt_in():
    _, _, engine = _engine()
    result = engine.run([_candidate()], {"BTC/USDT": 100.0}, enabled=False)
    assert result["status"] == "disabled"
    assert result["paper_entries"] == []


def test_total_drawdown_guard_blocks_new_orders():
    risk = dict(DEFAULT_RISK)
    try:
        size_position(
            capital=94.0,
            current_exposure=0,
            open_positions=0,
            requested_notional=10,
            price=100,
            risk=risk,
            current_equity=94.0,
            peak_equity=100.0,
        )
    except RiskRejected as exc:
        assert "drawdown" in str(exc).lower()
    else:
        raise AssertionError("Expected the peak-to-trough drawdown guard to reject the order")


def test_auto_paper_blocked_when_existing_position_lacks_fresh_mark():
    db, broker, engine = _engine()
    broker.open_long({"engine": "multi_crypto", "symbol": "ETH/USDT", "price_usd": 100})
    result = engine.run([_candidate("BTC/USDT")], {"BTC/USDT": 100.0}, enabled=True)
    assert result["paper_entries"] == []
    assert result["status"] == "blocked_unmarked_open_positions"


def test_auto_paper_closes_triggered_stop():
    db, broker, engine = _engine()
    trade = broker.open_long({"engine": "multi_crypto", "symbol": "BTC/USDT", "price_usd": 100})
    result = engine.run([], {"BTC/USDT": float(trade["stop_loss"]) - 0.5}, enabled=False)
    closed = next(t for t in db.list_trades() if t["id"] == trade["id"])
    assert result["paper_exits"] == 1
    assert closed["status"] == "CLOSED"


def test_portfolio_summary_marks_unrealized_pnl_and_exposure():
    db, broker, _ = _engine()
    broker.open_long({"engine": "multi_crypto", "symbol": "BTC/USDT", "price_usd": 100})
    risk = db.get_risk()
    summary = db.portfolio_summary({"BTC/USDT": 90.0}, risk["fee_bps_per_side"], risk["slippage_bps"])
    assert summary["unrealized_pnl_usd"] < 0
    assert summary["equity_usd"] < summary["initial_capital_usd"]
    assert summary["marked_positions"] == 1
    assert summary["unmarked_positions"] == 0


def test_auto_paper_rejects_stale_closed_candle_even_when_ticker_is_fresh():
    _, _, engine = _engine()
    candidate = _candidate()
    candidate["last_closed_candle_timestamp_ms"] = time.time() * 1000 - 4 * 3_600_000
    result = engine.run([candidate], {"BTC/USDT": 100.0}, enabled=True)
    assert result["paper_entries"] == []
    assert any(item["reason"] == "primary_closed_candle_stale" for item in result["rejected"])


def test_portfolio_drawdown_circuit_breaker_flattens_marked_paper_book_and_halts():
    db, broker, engine = _engine()
    risk = db.get_risk()
    risk["max_total_drawdown_pct"] = 1.0
    db.set_risk(risk)
    for symbol in ("BTC/USDT", "ETH/USDT", "SOL/USDT"):
        current_marks = {trade["symbol"]: 100.0 for trade in db.open_trades()}
        broker.open_long({
            "engine": "multi_crypto",
            "symbol": symbol,
            "price_usd": 100.0,
            "requested_notional_usd": 6.0,
            "_portfolio_marks": current_marks,
        })

    result = engine.run([], {
        "BTC/USDT": 94.0,
        "ETH/USDT": 94.0,
        "SOL/USDT": 94.0,
    }, enabled=True)

    assert result["status"] == "portfolio_drawdown_limit"
    assert result["halt_automation"] is True
    assert result["paper_exits"] == 3
    assert db.open_trades() == []
    assert all(t["status"] == "CLOSED" for t in db.list_trades())


def test_auto_paper_rejects_non_finite_signal_metrics():
    _, _, engine = _engine()
    candidate = _candidate()
    candidate["analysis"]["atr_pct"] = float("nan")
    result = engine.run([candidate], {"BTC/USDT": 100.0}, enabled=True)
    assert result["paper_entries"] == []
    assert any("invalid_volatility" in item["reason"] for item in result["rejected"])


def test_auto_paper_rejects_non_finite_orderbook_depth():
    _, _, engine = _engine()
    candidate = _candidate()
    candidate["ticker"]["bid_depth_quote"] = float("inf")
    result = engine.run([candidate], {"BTC/USDT": 100.0}, enabled=True)
    assert result["paper_entries"] == []
    assert any(item["reason"] == "orderbook_depth_unavailable" for item in result["rejected"])


def test_solana_screen_requires_holder_concentration_evidence():
    from app.services.strategy import score_solana_token

    token = {
        "is_sus": False, "banned": False, "mint_authority_disabled": True,
        "freeze_authority_disabled": True, "top_holders_percentage": None,
        "liquidity_usd": 250_000, "holders": 5_000, "verified": True,
        "organic_score": 100, "price_usd": 0.01,
    }
    result = score_solana_token(token)
    assert result["eligible_for_paper"] is False
    assert any("concentration" in flag.lower() for flag in result["flags"])


def test_solana_screen_rejects_malformed_concentration_value():
    from app.services.strategy import score_solana_token

    token = {
        "is_sus": False, "banned": False, "mint_authority_disabled": True,
        "freeze_authority_disabled": True, "top_holders_percentage": "not-a-number",
        "liquidity_usd": 250_000, "holders": 5_000, "verified": True,
        "organic_score": 100, "price_usd": 0.01,
    }
    result = score_solana_token(token)
    assert result["eligible_for_paper"] is False


def test_auto_paper_rejects_non_finite_strategy_score_without_crashing():
    _, _, engine = _engine()
    good = _candidate()
    bad = _candidate("ETH/USDT")
    bad["analysis"]["score"] = float("nan")
    result = engine.run([bad, good], {"BTC/USDT": 100.0, "ETH/USDT": 100.0}, enabled=True)
    assert len(result["paper_entries"]) == 1
    assert result["paper_entries"][0]["symbol"] == "BTC/USDT"


def test_portfolio_summary_treats_infinite_mark_as_unmarked():
    db, broker, _ = _engine()
    broker.open_long({"engine": "multi_crypto", "symbol": "BTC/USDT", "price_usd": 100})
    risk = db.get_risk()
    summary = db.portfolio_summary({"BTC/USDT": float("inf")}, risk["fee_bps_per_side"], risk["slippage_bps"])
    assert summary["unmarked_positions"] == 1
    assert summary["marked_positions"] == 0


def test_auto_paper_rejects_old_exchange_orderbook_even_if_recently_received():
    _, _, engine = _engine()
    candidate = _candidate()
    candidate["ticker"]["orderbook_timestamp_ms"] = time.time() * 1000 - 60_000
    candidate["ticker"]["orderbook_retrieved_at_ms"] = time.time() * 1000
    result = engine.run([candidate], {"BTC/USDT": 100.0}, enabled=True)
    assert result["paper_entries"] == []
    assert any(item["reason"] == "orderbook_snapshot_stale" for item in result["rejected"])


def test_auto_paper_fails_closed_on_invalid_persisted_risk_profile():
    db, _, engine = _engine()
    risk = db.get_risk()
    risk["take_profit_pct"] = 1.5  # below cost-aware 1:1 net reward/risk
    db.set_risk(risk)
    result = engine.run([_candidate()], {"BTC/USDT": 100.0}, enabled=True)
    assert result["status"] == "blocked_invalid_risk_profile"
    assert result["paper_entries"] == []
    assert result["halt_automation"] is True

def test_auto_paper_accepts_fresh_six_hour_confirmation_candle_from_fallback():
    db, _, engine = _engine()
    candidate = _candidate()
    now_ms = time.time() * 1000
    candidate["higher_timeframe_last_closed_candle_timestamp_ms"] = now_ms - 12 * 3_600_000
    candidate["higher_timeframe_interval_ms"] = 6 * 3_600_000
    eligible, reason, _ = engine._eligible(candidate, now_ms, db.get_risk())
    assert eligible is True
    assert reason == "eligible"


def test_auto_paper_still_rejects_stale_six_hour_confirmation_candle():
    db, _, engine = _engine()
    candidate = _candidate()
    now_ms = time.time() * 1000
    candidate["higher_timeframe_last_closed_candle_timestamp_ms"] = now_ms - 15 * 3_600_000
    candidate["higher_timeframe_interval_ms"] = 6 * 3_600_000
    eligible, reason, _ = engine._eligible(candidate, now_ms, db.get_risk())
    assert eligible is False
    assert reason == "higher_timeframe_closed_candle_stale"
