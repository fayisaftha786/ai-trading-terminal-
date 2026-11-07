import pytest
from datetime import datetime, timezone

from app.services.paper import PaperBroker
from app.storage import Storage


def test_paper_order_opens_and_closes_with_costs(tmp_path):
    db = Storage(tmp_path / "paper.db")
    db.initialize(100)
    broker = PaperBroker(db)
    trade = broker.open_long({"engine": "multi_crypto", "symbol": "BTC/USDT", "name": "Bitcoin",
                              "mint": "", "price_usd": 100, "requested_notional_usd": 20})
    assert trade["status"] == "OPEN"
    assert trade["entry_price"] > 100  # slippage applied
    assert trade["notional_usd"] <= 20.1
    closed = broker.close(trade["id"], 110, "test")
    assert closed["status"] == "CLOSED"
    assert closed["pnl_usd"] > 0
    assert closed["fees_usd"] > 0
    assert db.portfolio_summary()["equity_usd"] > 100


def test_risk_limit_blocks_excess_open_positions(tmp_path):
    db = Storage(tmp_path / "risk.db")
    db.initialize(100)
    broker = PaperBroker(db)
    current_marks = {}
    for i in range(3):
        broker.open_long({"engine": "multi_crypto", "symbol": f"COIN{i}/USDT", "price_usd": 10,
                          "requested_notional_usd": 2, "_portfolio_marks": current_marks})
        current_marks[f"COIN{i}/USDT"] = 10.0
    with pytest.raises(ValueError, match="Maximum open-position"):
        broker.open_long({"engine": "multi_crypto", "symbol": "FOURTH/USDT", "price_usd": 10,
                          "requested_notional_usd": 2, "_portfolio_marks": current_marks})


def test_auto_stop_and_target_close_positions(tmp_path):
    db = Storage(tmp_path / "trigger.db")
    db.initialize(100)
    broker = PaperBroker(db)
    trade = broker.open_long({"engine": "multi_crypto", "symbol": "SOL/USDT", "price_usd": 100,
                              "requested_notional_usd": 10})
    closed = broker.mark_and_close_triggers({"SOL/USDT": trade["take_profit"] + 1})
    assert len(closed) == 1
    assert closed[0]["status"] == "CLOSED"


def test_daily_realized_loss_guard_blocks_new_paper_trade(tmp_path):
    db = Storage(tmp_path / "daily-loss.db")
    db.initialize(100)
    with db.connection() as conn:
        now = datetime.now(timezone.utc).isoformat()
        conn.execute(
            "INSERT INTO trades(engine,symbol,side,status,entry_price,quantity,notional_usd,stop_loss,take_profit,"
            "opened_at,closed_at,exit_price,fees_usd,pnl_usd) VALUES('multi_crypto','LOSS/USDT','BUY','CLOSED',"
            "10,1,10,9,12,?,?,8,0,-1.5)", (now, now)
        )
    broker = PaperBroker(db)
    with pytest.raises(ValueError, match="Daily net-equity loss"):
        broker.open_long({"engine": "multi_crypto", "symbol": "BTC/USDT", "price_usd": 100,
                          "requested_notional_usd": 5})


def test_storage_unique_open_market_index_rejects_duplicate_row():
    import sqlite3
    import pytest

    db = Storage(":memory:")
    db.initialize(100)
    broker = PaperBroker(db)
    trade = broker.open_long({"engine": "multi_crypto", "symbol": "BTC/USDT", "price_usd": 100})

    with pytest.raises(sqlite3.IntegrityError):
        with db.connection() as conn:
            conn.execute(
                "INSERT INTO trades(engine,symbol,name,mint,side,status,entry_price,quantity,notional_usd,"
                "stop_loss,take_profit,fees_usd,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                ("multi_crypto", "BTC/USDT", "BTC/USDT", "", "BUY", "OPEN",
                 trade["entry_price"], trade["quantity"], trade["notional_usd"],
                 trade["stop_loss"], trade["take_profit"], trade["fees_usd"], "{}"),
            )


def test_requested_notional_is_not_exceeded_by_entry_slippage():
    db = Storage(":memory:")
    db.initialize(100)
    broker = PaperBroker(db)
    trade = broker.open_long({
        "engine": "multi_crypto", "symbol": "BTC/USDT", "price_usd": 100,
        "requested_notional_usd": 15,
    })
    assert trade["notional_usd"] <= 15.0000001


def test_paper_close_is_idempotent_under_repeated_close_attempts():
    db = Storage(":memory:")
    db.initialize(100)
    broker = PaperBroker(db)
    trade = broker.open_long({"engine": "multi_crypto", "symbol": "BTC/USDT", "price_usd": 100})
    closed = broker.close(trade["id"], 101, "test")
    assert closed["status"] == "CLOSED"
    try:
        broker.close(trade["id"], 102, "duplicate_test")
    except ValueError as exc:
        assert "already closed" in str(exc).lower()
    else:
        raise AssertionError("A repeated close must not close/log a trade twice")


def test_paper_close_rejects_non_finite_mark():
    db = Storage(":memory:")
    db.initialize(100)
    broker = PaperBroker(db)
    trade = broker.open_long({"engine": "multi_crypto", "symbol": "BTC/USDT", "price_usd": 100})
    with pytest.raises(ValueError, match="finite positive"):
        broker.close(trade["id"], float("nan"))


def test_close_reason_is_preserved_in_ledger_metadata():
    db = Storage(":memory:")
    db.initialize(100.0)
    broker = PaperBroker(db)
    trade = broker.open_long({
        "engine": "multi_crypto", "symbol": "BTC/USDT", "price_usd": 100.0,
    })
    closed = broker.close(trade["id"], 98.0, "portfolio_drawdown_circuit_breaker")
    assert closed["metadata"]["close_reason"] == "portfolio_drawdown_circuit_breaker"
    assert closed["metadata"]["close_reference_price"] == 98.0


def test_daily_net_equity_loss_includes_open_position_drawdown(tmp_path):
    db = Storage(tmp_path / "daily-equity-loss.db")
    db.initialize(100)
    # Establish the UTC day baseline while the portfolio is flat.
    db.portfolio_summary({})
    broker = PaperBroker(db)
    broker.open_long({"engine": "multi_crypto", "symbol": "BTC/USDT", "price_usd": 100,
                      "requested_notional_usd": 20, "_portfolio_marks": {}})
    current_mark = {"BTC/USDT": 90.0}
    summary = db.portfolio_summary(current_mark)
    assert summary["daily_equity_pnl_usd"] < -1.5
    with pytest.raises(ValueError, match="Daily net-equity loss"):
        broker.open_long({"engine": "multi_crypto", "symbol": "ETH/USDT", "price_usd": 100,
                          "requested_notional_usd": 5, "_portfolio_marks": current_mark})


def test_invalid_entry_risk_profile_does_not_block_emergency_position_close():
    db = Storage(":memory:")
    db.initialize(100)
    broker = PaperBroker(db)
    trade = broker.open_long({"engine": "multi_crypto", "symbol": "BTC/USDT", "price_usd": 100})
    risk = db.get_risk()
    risk["take_profit_pct"] = 1.5  # invalid for new entries after estimated costs
    db.set_risk(risk)
    closed = broker.close(trade["id"], 98.0, "emergency_test")
    assert closed["status"] == "CLOSED"
    assert closed["metadata"]["close_reason"] == "emergency_test"


def test_take_profit_exit_does_not_assume_favorable_price_improvement():
    db = Storage(":memory:")
    db.initialize(100)
    broker = PaperBroker(db)
    trade = broker.open_long({"engine": "multi_crypto", "symbol": "BTC/USDT",
                              "price_usd": 100, "requested_notional_usd": 10})
    target = float(trade["take_profit"])
    closed = broker.mark_and_close_triggers({"BTC/USDT": target * 1.10})[0]
    assert closed["metadata"]["close_reference_price"] == pytest.approx(target)
    assert closed["exit_price"] < target  # sell-side slippage still applies


def test_corrupt_trade_metadata_does_not_block_emergency_exit():
    db = Storage(":memory:")
    db.initialize(100)
    broker = PaperBroker(db)
    trade = broker.open_long({"engine": "multi_crypto", "symbol": "BTC/USDT", "price_usd": 100})
    with db.connection() as conn:
        conn.execute("UPDATE trades SET metadata_json='not-json' WHERE id=?", (trade["id"],))
    closed = broker.close(trade["id"], 95, "corrupt_metadata_emergency_exit")
    assert closed["status"] == "CLOSED"
    assert closed["metadata"]["metadata_recovered"] is True
    assert closed["metadata"]["close_reason"] == "corrupt_metadata_emergency_exit"


def test_concurrent_paper_entries_cannot_exceed_portfolio_exposure_cap():
    from concurrent.futures import ThreadPoolExecutor

    db = Storage(":memory:")
    db.initialize(100)
    broker = PaperBroker(db)
    symbols = [f"COIN{i}/USDT" for i in range(8)]
    marks = {symbol: 100.0 for symbol in symbols}

    def attempt(symbol):
        try:
            return broker.open_long({
                "engine": "multi_crypto", "symbol": symbol, "price_usd": 100,
                "requested_notional_usd": 15, "_portfolio_marks": marks,
            })
        except ValueError as exc:
            return str(exc)

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(attempt, symbols))
    opened = [item for item in results if isinstance(item, dict)]
    summary = db.portfolio_summary(marks)
    assert opened
    assert summary["open_positions"] <= db.get_risk()["max_open_positions"]
    assert summary["exposure_usd"] <= 20.0 + 1e-6
