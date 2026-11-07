from types import SimpleNamespace

import pytest

from app.services.testnet import BinanceSpotTestnet, TestnetUnavailable


def make_config(**overrides):
    values = {
        "binance_testnet_enabled": False,
        "binance_testnet_api_key": None,
        "binance_testnet_api_secret": None,
        "binance_testnet_order_enabled": False,
        "binance_testnet_max_order_usdt": 10.0,
        "binance_testnet_max_open_orders": 3,
        "cex_symbols": ("BTC/USDT", "ETH/USDT", "SOL/USDT"),
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_testnet_status_never_claims_live_trading():
    status = BinanceSpotTestnet(make_config()).status()
    assert status["environment"] == "testnet_only"
    assert status["production_endpoint_used"] is False
    assert status["live_trading_enabled"] is False
    assert status["ready_for_connection_check"] is False


def test_connection_fails_closed_when_disabled():
    with pytest.raises(TestnetUnavailable, match="disabled"):
        BinanceSpotTestnet(make_config()).check_account()


def test_connection_fails_closed_without_credentials():
    config = make_config(binance_testnet_enabled=True)
    with pytest.raises(TestnetUnavailable, match="credentials are missing"):
        BinanceSpotTestnet(config).check_account()


def test_connection_uses_ccxt_sandbox_and_only_returns_safe_account_fields(monkeypatch):
    import sys

    captured = {}

    class FakeExchange:
        def __init__(self, args):
            captured["args"] = args

        def set_sandbox_mode(self, enabled):
            captured["sandbox"] = enabled

        def fetch_balance(self):
            return {"free": {"USDT": 123.45, "BTC": 0.01, "ZERO": 0}}

        def close(self):
            captured["closed"] = True

    monkeypatch.setitem(sys.modules, "ccxt", SimpleNamespace(binance=FakeExchange))
    config = make_config(
        binance_testnet_enabled=True,
        binance_testnet_api_key="TEST_KEY",
        binance_testnet_api_secret="TEST_SECRET",
    )
    result = BinanceSpotTestnet(config).check_account()
    assert captured["sandbox"] is True
    assert captured["args"]["apiKey"] == "TEST_KEY"
    assert result["connected"] is True
    assert result["usdt_free"] == 123.45
    assert result["available_assets"] == ["BTC", "USDT"]
    assert "TEST_SECRET" not in str(result)
    assert result["live_trading_enabled"] is False
    assert captured["closed"] is True


def test_connection_error_does_not_leak_credentials(monkeypatch):
    import sys

    class FakeExchange:
        def __init__(self, args):
            pass

        def set_sandbox_mode(self, enabled):
            pass

        def fetch_balance(self):
            raise RuntimeError("request failed with TEST_SECRET")

        def close(self):
            pass

    monkeypatch.setitem(sys.modules, "ccxt", SimpleNamespace(binance=FakeExchange))
    config = make_config(
        binance_testnet_enabled=True,
        binance_testnet_api_key="TEST_KEY",
        binance_testnet_api_secret="TEST_SECRET",
    )
    with pytest.raises(TestnetUnavailable) as exc:
        BinanceSpotTestnet(config).check_account()
    assert "TEST_SECRET" not in str(exc.value)
    assert "RuntimeError" in str(exc.value)


class FakeExchange:
    def __init__(self, args, *, timeout_after_accept=False):
        self.args = args
        self.calls = []
        self.orders = []
        self.timeout_after_accept = timeout_after_accept
        self.has = {"fetchOrders": True}
        self.order_id = "test-order-101"

    def set_sandbox_mode(self, enabled):
        self.calls.append(("sandbox", enabled))

    def load_markets(self):
        self.calls.append(("load_markets",))

    def market(self, symbol):
        return {"symbol": symbol, "active": True, "spot": True,
                "limits": {"amount": {"min": 0.00001}, "cost": {"min": 5.0}}}

    def price_to_precision(self, symbol, price):
        return f"{float(price):.2f}"

    def amount_to_precision(self, symbol, amount):
        return f"{float(amount):.5f}"

    def fetch_balance(self):
        self.calls.append(("fetch_balance",))
        return {"free": {"USDT": 100.0, "BTC": 1.0}}

    def create_order(self, symbol, kind, side, amount, price, params):
        self.calls.append(("create_order", symbol, kind, side, amount, price, params))
        order = {"id": self.order_id, "clientOrderId": params["clientOrderId"],
                 "symbol": symbol, "status": "open", "filled": 0.0,
                 "remaining": amount, "amount": amount, "price": price,
                 "average": None, "cost": 0.0}
        self.orders.append(order)
        if self.timeout_after_accept:
            raise TimeoutError("timed out after matching-engine accepted request")
        return order

    def fetch_order(self, order_id, symbol):
        self.calls.append(("fetch_order", order_id, symbol))
        return self.orders[0]

    def fetch_orders(self, symbol, since=None, limit=None):
        self.calls.append(("fetch_orders", symbol, since, limit))
        return [order for order in self.orders if order["symbol"] == symbol]

    def cancel_order(self, order_id, symbol):
        self.calls.append(("cancel_order", order_id, symbol))
        self.orders[0]["status"] = "canceled"
        return self.orders[0]

    def close(self):
        self.calls.append(("close",))


def make_storage(tmp_path=None):
    from app.storage import Storage
    db = Storage(tmp_path / "testnet-orders.db" if tmp_path else ":memory:")
    db.initialize(100.0)
    return db


def make_order_service(monkeypatch, *, timeout_after_accept=False, **overrides):
    from app.services.testnet import BinanceSpotTestnet
    config_values = {
        "binance_testnet_enabled": True,
        "binance_testnet_api_key": "TEST_KEY",
        "binance_testnet_api_secret": "TEST_SECRET",
        "binance_testnet_order_enabled": True,
        "binance_testnet_max_order_usdt": 10.0,
        "binance_testnet_max_open_orders": 3,
        "cex_symbols": ("BTC/USDT", "ETH/USDT", "SOL/USDT"),
    }
    config_values.update(overrides)
    config = make_config(**config_values)
    exchange = FakeExchange({}, timeout_after_accept=timeout_after_accept)
    service = BinanceSpotTestnet(config, exchange_factory=lambda args: exchange)
    return service, exchange


def test_testnet_limit_order_is_sandboxed_bounded_and_idempotent(monkeypatch):
    from app.services.testnet import TestnetOrderUncertain
    service, exchange = make_order_service(monkeypatch)
    db = make_storage()
    request = {"idempotency_key": "buy-btc-order-001", "symbol": "BTC/USDT",
               "side": "buy", "amount": 0.0001, "price": 50000.0}
    first = service.create_limit_order(request, db)
    second = service.create_limit_order(request, db)
    assert first["replayed"] is False
    assert second["replayed"] is True
    assert first["order"]["status"] == "OPEN"
    assert first["order"]["notional_usdt"] == 5.0
    assert len([call for call in exchange.calls if call[0] == "create_order"]) == 1
    assert exchange.calls[0] == ("sandbox", True)
    create = next(call for call in exchange.calls if call[0] == "create_order")
    assert create[2] == "limit"
    assert create[6]["timeInForce"] == "GTC"
    assert create[6]["clientOrderId"].startswith("att")
    assert "TEST_SECRET" not in str(first)


def test_testnet_timeout_is_unknown_and_same_key_cannot_resubmit(monkeypatch):
    from app.services.testnet import TestnetOrderUncertain
    service, exchange = make_order_service(monkeypatch, timeout_after_accept=True)
    db = make_storage()
    request = {"idempotency_key": "buy-eth-order-002", "symbol": "ETH/USDT",
               "side": "buy", "amount": 0.1, "price": 100.0}
    with pytest.raises(TestnetOrderUncertain, match="will not resubmit"):
        service.create_limit_order(request, db)
    record = db.get_testnet_order_by_key(request["idempotency_key"])
    assert record["status"] == "UNKNOWN"
    with pytest.raises(TestnetOrderUncertain, match="do not submit again"):
        service.create_limit_order(request, db)
    assert len([call for call in exchange.calls if call[0] == "create_order"]) == 1


def test_testnet_unknown_order_reconciles_by_client_id_after_timeout(monkeypatch):
    from app.services.testnet import TestnetOrderUncertain
    service, exchange = make_order_service(monkeypatch, timeout_after_accept=True)
    db = make_storage()
    request = {"idempotency_key": "buy-sol-order-003", "symbol": "SOL/USDT",
               "side": "buy", "amount": 0.1, "price": 50.0}
    with pytest.raises(TestnetOrderUncertain):
        service.create_limit_order(request, db)
    record = db.get_testnet_order_by_key(request["idempotency_key"])
    result = service.refresh_order(record["client_order_id"], db)
    assert result["reconciled"] is True
    assert result["order"]["status"] == "OPEN"
    assert result["order"]["exchange_order_id"] == "test-order-101"


def test_testnet_cancel_only_open_known_exchange_order(monkeypatch):
    service, exchange = make_order_service(monkeypatch)
    db = make_storage()
    request = {"idempotency_key": "buy-btc-order-004", "symbol": "BTC/USDT",
               "side": "buy", "amount": 0.0001, "price": 50000.0}
    placed = service.create_limit_order(request, db)
    result = service.cancel_order(placed["order"]["client_order_id"], db)
    assert result["order"]["status"] == "CANCELED"
    assert any(call[0] == "cancel_order" for call in exchange.calls)


def test_testnet_order_gate_fails_closed(monkeypatch):
    from app.services.testnet import BinanceSpotTestnet, TestnetUnavailable
    config = make_config(binance_testnet_enabled=True, binance_testnet_api_key="KEY",
                         binance_testnet_api_secret="SECRET", binance_testnet_order_enabled=False,
                         binance_testnet_max_order_usdt=10.0, binance_testnet_max_open_orders=3,
                         cex_symbols=("BTC/USDT",))
    service = BinanceSpotTestnet(config)
    with pytest.raises(TestnetUnavailable, match="order execution is locked"):
        service.create_limit_order({"idempotency_key": "test-order-key-001", "symbol": "BTC/USDT",
                                    "side": "buy", "amount": 0.001, "price": 100.0}, make_storage())


def test_testnet_order_rejects_non_allowlisted_market_before_exchange(monkeypatch):
    from app.services.testnet import TestnetOrderRejected
    service, exchange = make_order_service(monkeypatch)
    with pytest.raises(TestnetOrderRejected, match="allowlist"):
        service.create_limit_order({"idempotency_key": "buy-doge-order-005", "symbol": "DOGE/USDT",
                                    "side": "buy", "amount": 1, "price": 0.1}, make_storage())
    assert exchange.calls == []


def test_testnet_order_rejects_order_over_notional_cap(monkeypatch):
    from app.services.testnet import TestnetOrderRejected
    service, exchange = make_order_service(monkeypatch)
    with pytest.raises(TestnetOrderRejected, match="cap"):
        service.create_limit_order({"idempotency_key": "buy-btc-order-006", "symbol": "BTC/USDT",
                                    "side": "buy", "amount": 0.001, "price": 50000.0}, make_storage())
    assert not any(call[0] == "create_order" for call in exchange.calls)


def test_testnet_unknown_orders_consume_open_order_cap(monkeypatch):
    from app.services.testnet import TestnetOrderUncertain, TestnetOrderRejected
    service, exchange = make_order_service(monkeypatch, timeout_after_accept=True,
                                           binance_testnet_max_open_orders=1)
    db = make_storage()
    request = {"idempotency_key": "buy-btc-order-007", "symbol": "BTC/USDT",
               "side": "buy", "amount": 0.0001, "price": 50000.0}
    with pytest.raises(TestnetOrderUncertain):
        service.create_limit_order(request, db)
    with pytest.raises(TestnetOrderRejected, match="Maximum number"):
        service.create_limit_order({**request, "idempotency_key": "buy-eth-order-008", "symbol": "ETH/USDT"}, db)


def test_testnet_order_api_gate_stays_closed_by_default(client):
    response = client.post("/api/testnet/orders", json={
        "idempotency_key": "disabled-testnet-001", "symbol": "BTC/USDT",
        "side": "buy", "amount": 0.0001, "price": 50000,
    })
    assert response.status_code == 409
    assert "locked" in response.json()["detail"].lower()
    assert client.get("/api/testnet/orders").json()["orders"] == []


def test_testnet_order_api_submit_refresh_cancel_and_idempotency(tmp_path):
    from dataclasses import replace
    from fastapi.testclient import TestClient
    from app.main import create_app
    from app.settings import settings

    config = replace(
        settings,
        database_path=tmp_path / "testnet-api.db",
        binance_testnet_enabled=True,
        binance_testnet_api_key="TEST_KEY",
        binance_testnet_api_secret="TEST_SECRET",
        binance_testnet_order_enabled=True,
        binance_testnet_max_order_usdt=10.0,
        binance_testnet_max_open_orders=3,
        cex_symbols=("BTC/USDT", "ETH/USDT", "SOL/USDT"),
    )
    app = create_app(config=config, db_path=config.database_path)
    exchange = FakeExchange({})
    app.state.testnet._exchange_factory = lambda args: exchange
    payload = {"idempotency_key": "api-buy-btc-0001", "symbol": "BTC/USDT",
               "side": "buy", "amount": 0.0001, "price": 50000}
    with TestClient(app) as api_client:
        status = api_client.get("/api/testnet/status").json()
        assert status["order_execution_enabled"] is True
        assert status["live_trading_enabled"] is False
        created = api_client.post("/api/testnet/orders", json=payload)
        assert created.status_code == 200
        order = created.json()["order"]
        assert order["status"] == "OPEN"
        repeated = api_client.post("/api/testnet/orders", json=payload)
        assert repeated.status_code == 200
        assert repeated.json()["replayed"] is True
        refreshed = api_client.post(f"/api/testnet/orders/{order['client_order_id']}/refresh")
        assert refreshed.status_code == 200
        canceled = api_client.post(f"/api/testnet/orders/{order['client_order_id']}/cancel")
        assert canceled.status_code == 200
        assert canceled.json()["order"]["status"] == "CANCELED"
        assert len(api_client.get("/api/testnet/orders").json()["orders"]) == 1
        assert api_client.post("/api/live/execute").status_code == 423


def test_testnet_api_rejects_schema_invalid_symbols(client):
    response = client.post("/api/testnet/orders", json={
        "idempotency_key": "bad-symbol-0001", "symbol": "DOGE/BTC",
        "side": "buy", "amount": 1.0, "price": 0.1,
    })
    assert response.status_code == 422


def test_existing_database_migrates_testnet_order_ledger(tmp_path):
    db = make_storage(tmp_path)
    db.create_testnet_order({
        "idempotency_key": "migration-check-001", "client_order_id": "attmigration001",
        "symbol": "BTC/USDT", "side": "BUY", "amount": 0.0001,
        "price": 50000, "notional_usdt": 5, "status": "SUBMITTING",
    })
    row = db.get_testnet_order_by_key("migration-check-001")
    assert row["status"] == "SUBMITTING"
    assert db.count_open_testnet_orders() == 1


def test_testnet_emergency_stop_latches_and_cancels_app_owned_orders(monkeypatch):
    from app.services.testnet import TestnetUnavailable
    service, exchange = make_order_service(monkeypatch)
    db = make_storage()
    request = {"idempotency_key": "emergency-stop-order-01", "symbol": "BTC/USDT",
               "side": "buy", "amount": 0.0001, "price": 50000}
    placed = service.create_limit_order(request, db)
    client_id = placed["order"]["client_order_id"]
    result = service.emergency_stop(db)
    assert result["halted"] is True
    assert client_id in result["canceled_client_order_ids"]
    assert db.get_setting("testnet_order_halted") is True
    assert db.count_open_testnet_orders() == 0
    with pytest.raises(TestnetUnavailable, match="emergency order lock"):
        service.create_limit_order({**request, "idempotency_key": "emergency-stop-order-02"}, db)


def test_testnet_emergency_stop_keeps_unresolved_state_blocking(monkeypatch):
    from app.services.testnet import TestnetOrderUncertain
    service, exchange = make_order_service(monkeypatch, timeout_after_accept=True)
    db = make_storage()
    request = {"idempotency_key": "emergency-unknown-order-01", "symbol": "BTC/USDT",
               "side": "buy", "amount": 0.0001, "price": 50000}
    with pytest.raises(TestnetOrderUncertain):
        service.create_limit_order(request, db)
    result = service.emergency_stop(db)
    assert result["halted"] is True
    assert result["canceled_client_order_ids"]
    assert not result["unresolved_client_order_ids"]
    assert db.count_open_testnet_orders() == 0


def test_testnet_kill_switch_reset_requires_explicit_confirmation_and_clean_ledger(tmp_path):
    from dataclasses import replace
    from fastapi.testclient import TestClient
    from app.main import create_app
    from app.settings import settings
    config = replace(settings, database_path=tmp_path / "testnet-reset.db")
    app = create_app(config=config, db_path=config.database_path)
    with TestClient(app) as api_client:
        bad = api_client.post("/api/testnet/kill-switch/reset", json={"confirmation": "yes"})
        assert bad.status_code == 422
        halted = api_client.post("/api/testnet/kill-switch")
        assert halted.status_code == 200
        assert halted.json()["halted"] is True
        assert api_client.get("/api/testnet/status").json()["emergency_halted"] is True
        good = api_client.post("/api/testnet/kill-switch/reset", json={
            "confirmation": "RESET TESTNET ORDER LOCK"})
        assert good.status_code == 200
        assert api_client.get("/api/testnet/status").json()["emergency_halted"] is False


def test_testnet_partial_fill_is_not_misreported_as_untouched_open_order(monkeypatch):
    service, exchange = make_order_service(monkeypatch)
    db = make_storage()
    request = {"idempotency_key": "partial-fill-order-001", "symbol": "BTC/USDT",
               "side": "buy", "amount": 0.0001, "price": 50000}
    placed = service.create_limit_order(request, db)
    client_id = placed["order"]["client_order_id"]
    exchange.orders[0]["filled"] = 0.00005
    exchange.orders[0]["remaining"] = 0.00005
    refreshed = service.refresh_order(client_id, db)
    assert refreshed["order"]["status"] == "PARTIALLY_FILLED"
    assert refreshed["order"]["filled"] == 0.00005


def test_testnet_database_reservation_respects_persistent_emergency_latch():
    db = make_storage()
    db.set_setting("testnet_order_halted", True)
    with pytest.raises(ValueError, match="emergency order lock"):
        db.create_testnet_order({
            "idempotency_key": "halted-order-reserve-001", "client_order_id": "att-halted001",
            "symbol": "BTC/USDT", "side": "BUY", "amount": 0.0001,
            "price": 50000, "notional_usdt": 5, "status": "SUBMITTING",
        })


def test_testnet_emergency_stop_serializes_against_inflight_submission(monkeypatch):
    import threading
    import time
    from concurrent.futures import ThreadPoolExecutor
    service, _ = make_order_service(monkeypatch)
    db = make_storage()
    started = threading.Event()
    release = threading.Event()

    class SlowExchange(FakeExchange):
        def create_order(self, symbol, kind, side, amount, price, params):
            started.set()
            assert release.wait(3), "test did not release the in-flight sandbox submission"
            return super().create_order(symbol, kind, side, amount, price, params)

    exchange = SlowExchange({})
    service._exchange_factory = lambda args: exchange
    request = {"idempotency_key": "slow-order-lock-001", "symbol": "BTC/USDT",
               "side": "buy", "amount": 0.0001, "price": 50000}
    with ThreadPoolExecutor(max_workers=2) as pool:
        submit_future = pool.submit(service.create_limit_order, request, db)
        assert started.wait(2)
        stop_future = pool.submit(service.emergency_stop, db)
        time.sleep(0.05)
        assert not stop_future.done(), "emergency-stop path must serialize behind active order submission"
        release.set()
        placed = submit_future.result(timeout=3)
        stopped = stop_future.result(timeout=3)
    assert placed["order"]["status"] == "OPEN"
    assert stopped["halted"] is True
    assert placed["order"]["client_order_id"] in stopped["canceled_client_order_ids"]
    assert db.count_open_testnet_orders() == 0


def test_unknown_exchange_order_status_is_kept_unresolved_and_counted():
    from app.services.testnet import BinanceSpotTestnet
    normal = BinanceSpotTestnet._normalise_order({
        "id": "x", "status": "provider_pending_state", "filled": 0,
        "remaining": 1, "amount": 1,
    })
    assert normal["status"] == "UNKNOWN"
    db = make_storage()
    db.create_testnet_order({
        "idempotency_key": "unknown-status-001", "client_order_id": "attunknownstatus001",
        "symbol": "BTC/USDT", "side": "BUY", "amount": 1, "price": 10,
        "notional_usdt": 10, "status": "SUBMITTING",
    })
    db.update_testnet_order("attunknownstatus001", normal)
    assert db.get_testnet_order_by_client_id("attunknownstatus001")["status"] == "UNKNOWN"
    assert db.count_open_testnet_orders() == 1


def test_definitive_exchange_rejection_is_not_left_unknown(monkeypatch):
    from app.services.testnet import TestnetOrderRejected
    service, exchange = make_order_service(monkeypatch)

    class InvalidOrder(Exception):
        pass

    def reject(*args, **kwargs):
        raise InvalidOrder("exchange rejected order")

    exchange.create_order = reject
    db = make_storage()
    request = {"idempotency_key": "exchange-reject-001", "symbol": "BTC/USDT",
               "side": "buy", "amount": 0.0001, "price": 50000}
    with pytest.raises(TestnetOrderRejected, match="definitively rejected"):
        service.create_limit_order(request, db)
    record = db.get_testnet_order_by_key(request["idempotency_key"])
    assert record["status"] == "REJECTED"
    assert db.count_open_testnet_orders() == 0


def test_testnet_emergency_stop_finds_old_active_order_beyond_recent_ui_history(monkeypatch):
    service, exchange = make_order_service(monkeypatch)
    db = make_storage()
    request = {"idempotency_key": "old-active-order-001", "symbol": "BTC/USDT",
               "side": "buy", "amount": 0.0001, "price": 50000}
    placed = service.create_limit_order(request, db)
    active_client_id = placed["order"]["client_order_id"]
    # More than the UI's 100-row history window of terminal orders must not hide
    # the older unresolved/open order from emergency cancellation.
    for index in range(105):
        db.create_testnet_order({
            "idempotency_key": f"terminal-order-{index:03d}",
            "client_order_id": f"attterminal{index:03d}",
            "symbol": "BTC/USDT", "side": "BUY", "amount": 0.0001,
            "price": 50000, "notional_usdt": 5, "status": "CANCELED",
        })
    assert len(db.list_testnet_orders(100)) == 100
    assert len(db.list_active_testnet_orders()) == 1
    result = service.emergency_stop(db)
    assert active_client_id in result["canceled_client_order_ids"]
    assert result["unresolved_client_order_ids"] == []
    assert db.count_open_testnet_orders() == 0


def _make_auto_signal():
    import time

    now = time.time() * 1000
    return {
        "ticker": {
            "symbol": "BTC/USDT", "status": "live", "last": 100.0,
            "bid": 99.99, "ask": 100.0, "quote_volume": 5_000_000,
            "timestamp": now, "bid_depth_quote": 250_000, "ask_depth_quote": 250_000,
            "orderbook_retrieved_at_ms": now, "orderbook_timestamp_ms": now,
            "orderbook_timestamp_source": "exchange",
        },
        "analysis": {
            "signal": "BUY_CANDIDATE", "score": 82, "regime": "UPTREND",
            "atr_pct": 1.2, "rsi14": 56.0, "adx14": 25.0,
            "plus_di14": 30.0, "minus_di14": 20.0,
        },
        "higher_timeframe": {"regime": "UPTREND"},
        "timeframe_confluence": "ALIGNED",
        "last_closed_candle_timestamp_ms": now - 3_605_000,
        "higher_timeframe_last_closed_candle_timestamp_ms": now - 4 * 3_600_000 - 5_000,
    }


class FakeOPOCOExchange:
    def __init__(self, *, permissions=True, working_status="open", list_status="EXECUTING"):
        self.permissions = permissions
        self.working_status = working_status
        self.list_status = list_status
        self.calls = []
        self.orders = {
            "501": {"id": "501", "status": working_status, "filled": 0.0999, "remaining": 0.0,
                    "amount": 0.0999, "average": 100.0, "cost": 9.99, "fee": None},
            "502": {"id": "502", "status": "open", "filled": 0.0, "remaining": 0.099,
                    "amount": 0.099, "average": None, "cost": 0.0, "fee": None},
            "503": {"id": "503", "status": "open", "filled": 0.0, "remaining": 0.099,
                    "amount": 0.099, "average": None, "cost": 0.0, "fee": None},
        }

    def set_sandbox_mode(self, enabled):
        self.calls.append(("sandbox", enabled))

    def load_markets(self):
        self.calls.append(("load_markets",))

    def market(self, symbol):
        return {
            "symbol": symbol, "id": symbol.replace("/", ""), "active": True, "spot": True,
            "info": {"otoAllowed": self.permissions, "opoAllowed": self.permissions,
                     "ocoAllowed": self.permissions},
            "limits": {"amount": {"min": 0.000001}, "cost": {"min": 5.0}},
        }

    def price_to_precision(self, symbol, value):
        return f"{float(value):.2f}"

    def amount_to_precision(self, symbol, value):
        return f"{float(value):.6f}"

    def fetch_balance(self):
        return {"free": {"USDT": 1000.0}}

    def request(self, path, api, method, params):
        self.calls.append((path, api, method, params))
        if method == "POST":
            return {
                "orderListId": 456, "listOrderStatus": "EXECUTING",
                "orders": [{"orderId": 501}, {"orderId": 502}, {"orderId": 503}],
                "orderReports": [{"orderId": 501}],
            }
        if method == "GET":
            return {
                "orderListId": 456, "listOrderStatus": self.list_status,
                "orders": [{"orderId": 501}, {"orderId": 502}, {"orderId": 503}],
            }
        if method == "DELETE":
            return {"orderListId": 456, "listOrderStatus": "ALL_DONE"}
        raise AssertionError("Unexpected OPOCO request")

    def fetch_order(self, order_id, symbol):
        return dict(self.orders[str(order_id)])

    def close(self):
        self.calls.append(("close",))


def _make_auto_trader(monkeypatch, *, permissions=True, working_status="open", list_status="EXECUTING"):
    from app.services.automation import AutoPaperEngine
    from app.services.paper import PaperBroker
    from app.services.testnet_auto import TestnetAutoTrader

    config = make_config(
        binance_testnet_enabled=True,
        binance_testnet_api_key="TEST_KEY",
        binance_testnet_api_secret="TEST_SECRET",
        binance_testnet_order_enabled=True,
        binance_testnet_max_order_usdt=10.0,
        binance_testnet_max_open_orders=3,
    )
    exchange = FakeOPOCOExchange(permissions=permissions, working_status=working_status, list_status=list_status)
    db = make_storage()
    adapter = BinanceSpotTestnet(config, exchange_factory=lambda args: exchange)
    engine = AutoPaperEngine(db, PaperBroker(db))
    return db, exchange, TestnetAutoTrader(adapter, db, engine)


def test_testnet_auto_uses_opoco_net_received_quantity_and_fok_entry(monkeypatch):
    db, exchange, trader = _make_auto_trader(monkeypatch)
    result = trader.run([_make_auto_signal()], True)
    assert result["status"] == "submitted"
    assert result["submitted"][0]["environment"] == "testnet_only"
    post = next(call for call in exchange.calls if len(call) == 4 and call[2] == "POST")
    assert post[0] == "orderList/opoco"
    assert post[3]["workingTimeInForce"] == "FOK"
    assert post[3]["pendingAboveType"] == "TAKE_PROFIT"
    assert post[3]["pendingBelowType"] == "STOP_LOSS"
    assert "pendingQuantity" not in post[3]
    assert db.count_open_testnet_auto_orders() == 1
    assert db.get_setting("testnet_order_halted", False) is False


def test_testnet_auto_refuses_symbols_without_explicit_opoco_permissions(monkeypatch):
    db, exchange, trader = _make_auto_trader(monkeypatch, permissions=False)
    result = trader.run([_make_auto_signal()], True)
    assert result["submitted"] == []
    assert any(
        item["reason"] == "testnet_symbol_does_not_confirm_OPOCO_permissions"
        for item in result["rejected"]
    )
    assert not any(len(call) == 4 and call[2] == "POST" for call in exchange.calls)
    assert db.count_open_testnet_auto_orders() == 0




def test_testnet_auto_does_not_mark_cancelled_exit_child_as_completed(monkeypatch):
    db, exchange, trader = _make_auto_trader(
        monkeypatch, working_status="closed", list_status="ALL_DONE"
    )
    # A terminal child with zero fill is not proof that TP or SL executed.
    exchange.orders["502"]["status"] = "closed"
    exchange.orders["502"]["filled"] = 0.0
    exchange.orders["503"]["status"] = "canceled"
    assert trader.run([_make_auto_signal()], True)["status"] == "submitted"
    # Reconcile the persisted order-list after changing the exchange-side state.
    result = trader.reconcile()
    row = db.list_testnet_auto_orders(1)[0]
    assert result["unresolved"] == 1
    assert row["status"] == "UNPROTECTED"
    assert row["error_code"] == "FILLED_ENTRY_WITHOUT_CONFIRMED_EXIT"


def test_testnet_auto_marks_bracket_completed_only_after_filled_exit_and_all_done(monkeypatch):
    db, exchange, trader = _make_auto_trader(
        monkeypatch, working_status="closed", list_status="ALL_DONE"
    )
    exchange.orders["502"]["status"] = "closed"
    exchange.orders["502"]["filled"] = 0.099
    exchange.orders["503"]["status"] = "canceled"
    assert trader.run([_make_auto_signal()], True)["status"] == "submitted"
    result = trader.reconcile()
    row = db.list_testnet_auto_orders(1)[0]
    assert result["completed"] == 1
    assert row["status"] == "CLOSED"


def test_testnet_auto_kill_switch_preserves_exchange_native_exits_for_filled_entry(monkeypatch):
    db, exchange, trader = _make_auto_trader(monkeypatch, working_status="closed")
    assert trader.run([_make_auto_signal()], True)["status"] == "submitted"
    result = trader.emergency_stop()
    assert result["halted"] is True
    assert result["protection_preserved_for_filled_entries"]
    assert not result["canceled_unfilled_order_lists"]
    assert not any(len(call) == 4 and call[2] == "DELETE" for call in exchange.calls)
    assert db.get_setting("testnet_auto_trading_enabled") is False
